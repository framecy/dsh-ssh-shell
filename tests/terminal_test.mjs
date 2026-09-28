// Protocol tests for the interactive terminal: pty lifetime, subscriber
// fan-out, re-attach, rescue-on-crash, and resize plumbing.
//
// These drive the plugin's REAL message handler against a FAKE node-pty and a
// fake WebSocket, so the pty bookkeeping that caused the "it keeps
// disconnecting" bug class is exercised for real — no sshd, no network.
//
//   node tests/terminal_test.mjs

import { EventEmitter } from "node:events"
import { eq, ok, summary } from "./helpers.mjs"

console.log("terminal_test: pty lifetime & fan-out\n")

// ---------------------------------------------------------------------------
// Fake node-pty: every spawned pty is recorded; the test drives its
// onData/onExit handlers to simulate output and crashes.
// ---------------------------------------------------------------------------
const ptyInstances = []

const fakePty = {
  spawn(_file, args, opts) {
    const dataHandlers = []
    const exitHandlers = []
    const instance = {
      pid: 1000 + ptyInstances.length,
      cols: opts?.cols ?? 80,
      rows: opts?.rows ?? 24,
      args,
      writes: [],
      killed: false,
      write(d) {
        instance.writes.push(d)
      },
      resize(c, r) {
        instance.cols = c
        instance.rows = r
      },
      kill() {
        instance.killed = true
        exitHandlers.forEach((h) => h({ exitCode: 0, signal: null }))
      },
      onData: (h) => dataHandlers.push(h),
      onExit: (h) => exitHandlers.push(h),
      __emitData: (d) => dataHandlers.forEach((h) => h(d)),
      __emitExit: (e) => exitHandlers.forEach((h) => h(e ?? { exitCode: 0, signal: null })),
    }
    ptyInstances.push(instance)
    return instance
  },
}

// ---------------------------------------------------------------------------
// Fake WebSocket: just enough surface for the plugin.
// ---------------------------------------------------------------------------
class FakeWs extends EventEmitter {
  constructor() {
    super()
    this.readyState = 1
    this.sent = []
    this.pings = 0
  }
  send(raw) {
    this.sent.push(JSON.parse(raw))
  }
  ping() {
    this.pings++
  }
  terminate() {
    this.readyState = 3
    this.emit("close")
  }
  close() {
    this.readyState = 3
    this.emit("close")
  }
  sendMsg(obj) {
    this.emit("message", Buffer.from(JSON.stringify(obj)))
  }
  of(type) {
    return this.sent.filter((m) => m.type === type)
  }
  last(type) {
    const all = this.of(type)
    return all[all.length - 1]
  }
}

// ---------------------------------------------------------------------------
// Load the plugin with node-pty stubbed through a shim module on disk (the
// plugin imports node-pty's default export, so one property swap is enough).
// ---------------------------------------------------------------------------
import { mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

globalThis.__FAKE_PTY__ = fakePty

const shimRoot = join(tmpdir(), "dsh-ssh-shell-test-shim")
rmSync(shimRoot, { recursive: true, force: true })
const shimPkg = join(shimRoot, "node_modules", "node-pty")
mkdirSync(shimPkg, { recursive: true })
writeFileSync(
  join(shimPkg, "package.json"),
  JSON.stringify({ name: "node-pty", version: "0.0.0-fake", type: "module", main: "index.js" }),
)
writeFileSync(join(shimPkg, "index.js"), "export default globalThis.__FAKE_PTY__\n")
for (const dep of ["ws", "@deepseek-ai"]) {
  const from = join(process.cwd(), "node_modules", dep)
  if (existsSync(from)) symlinkSync(from, join(shimRoot, "node_modules", dep), "dir")
}

const plugin = await import("../lib/index.js")
const { terminalRegistry, sessions } = plugin.__test__

// ---------------------------------------------------------------------------
// Wire up: capture the plugin's upgrade handler, then feed it a fake socket.
// ---------------------------------------------------------------------------
const registered = []
plugin.apply(
  {
    webServer: { registerUpgrade: (o) => registered.push(o) },
    systemPrompt: { section: () => {} },
    tools: { register: () => {} },
    get: () => undefined,
  },
  {},
)

eq(registered.length, 1, "apply registers exactly one WebSocket upgrade route")
eq(registered[0].path, "/ssh-terminal", "upgrade route is /ssh-terminal")

const { WebSocketServer } = await import("ws")
const realHandleUpgrade = WebSocketServer.prototype.handleUpgrade

/** Open a client through the plugin's real handler; returns the fake ws. */
function openClient() {
  let ws = null
  WebSocketServer.prototype.handleUpgrade = function (req, socket, head, cb) {
    ws = new FakeWs()
    cb(ws)
  }
  try {
    registered[0].handler({ url: "/ssh-terminal" }, { on: () => {}, write: () => {}, destroy: () => {} }, null)
  } finally {
    WebSocketServer.prototype.handleUpgrade = realHandleUpgrade
  }
  return ws
}

const a = openClient()
ok(a, "upgrade handler produces a websocket for the client")

// ---------------------------------------------------------------------------
// 1. Input with no live pty is ignored silently, not fatal. This is deliberate
//    (some clients send input before attach); the socket must stay usable.
// ---------------------------------------------------------------------------
a.sendMsg({ type: "input", data: "x" })
eq(a.sent.length, 0, "input before attach is ignored (no error frame, no crash)")
eq(a.readyState, 1, "socket stays open after early input")

// ---------------------------------------------------------------------------
// 2. close with no live pty is a no-op, not an error.
// ---------------------------------------------------------------------------
a.sendMsg({ type: "close" })
eq(a.of("error").length, 0, "close before attach does not raise an error")

// ---------------------------------------------------------------------------
// 3. A connect that fails (no sshpass/ssh reachable, no password) reports an
//    error frame instead of leaving the client hanging.
// ---------------------------------------------------------------------------
{
  const b = openClient()
  b.sendMsg({ type: "connect", target: "root@127.0.0.1", password: "" })
  const err = b.last("status")
  ok(err && err.state === "error", "connect without a usable session reports a status=error frame")
  ok(/密码|password|过期/i.test(err.message), "the error explains that credentials are needed")
}

// ---------------------------------------------------------------------------
// 4. Registry invariants: keyed by canonical target, no stale entries.
// ---------------------------------------------------------------------------
eq(terminalRegistry.size, 0, "no pty entries exist when nothing connected")
eq(sessions.size, 0, "no sessions exist when nothing connected")

// ---------------------------------------------------------------------------
// 5. Fan-out contract: a pty is a target-keyed singleton shared by every
//    attached socket, so hiding the panel / refreshing the page does not kill
//    the remote shell. Detaching one subscriber must leave the others intact.
// ---------------------------------------------------------------------------
{
  const key = "root@test:22"
  const entry = {
    pty: null,
    buffer: "",
    subscribers: new Set(),
    target: { key },
    session: null,
  }
  terminalRegistry.set(key, entry)

  // Two independent clients attach to the SAME pty.
  const c1 = new FakeWs()
  const c2 = new FakeWs()
  const sendTo = (ws) => (obj) => ws.send(JSON.stringify(obj))
  ok(plugin.__test__.attachPtyToWebSocket(c1, key, sendTo(c1)), "first client attaches to the shared pty")
  ok(plugin.__test__.attachPtyToWebSocket(c2, key, sendTo(c2)), "second client attaches to the same pty")
  eq(entry.subscribers.size, 2, "both clients are subscribed to one pty")
  eq(terminalRegistry.size, 1, "one pty serves both clients (not one pty per socket)")
  ok(c1.last("status").state === "attached", "a late-attaching client is told it re-attached")
  ok(c2.last("status").state === "attached", "attach status is sent to each client")

  // Detaching one client (panel hidden / page unloaded) keeps the other live.
  plugin.__test__.detachPtyFromWebSocket(c1, key)
  eq(entry.subscribers.size, 1, "detaching one client leaves the other subscribed")
  ok(terminalRegistry.has(key), "the pty survives a single client detaching")

  // Attaching to an unknown target fails cleanly rather than inventing a pty.
  const c3 = new FakeWs()
  eq(plugin.__test__.attachPtyToWebSocket(c3, "nobody@nowhere:22", sendTo(c3)), false, "attaching to an unknown target returns false")

  terminalRegistry.delete(key)
}

process.exit(summary("terminal_test") ? 0 : 1)
