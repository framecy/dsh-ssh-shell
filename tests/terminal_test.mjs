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
const tools = {}
plugin.apply(
  {
    webServer: { registerUpgrade: (o) => registered.push(o) },
    systemPrompt: { section: () => {} },
    tools: { register: (t) => { tools[t.name] = t } },
    get: () => undefined,
  },
  { installSkill: false },
)

eq(registered.length, 1, "apply registers exactly one WebSocket upgrade route")
eq(registered[0].path, "/ssh-terminal", "upgrade route is /ssh-terminal")

// A second apply() in the same process hits the host's duplicate-route refusal.
// That must degrade to a warning, not fail the entry (which the host reports as
// "did not activate" and the plugin manager reads as a broken update).
const warnings = []
let secondApplyThrew = null
try {
  plugin.apply(
    {
      webServer: {
        registerUpgrade: () => {
          throw new Error('webserver: duplicate upgrade route "/ssh-terminal"')
        },
      },
      systemPrompt: { section: () => {} },
      tools: { register: () => {} },
      logger: (level) => (message) => warnings.push([level, message]),
      get: () => undefined,
    },
    { installSkill: false },
  )
} catch (error) {
  secondApplyThrew = error
}
eq(secondApplyThrew, null, "a duplicate upgrade route does not fail apply()")
eq(warnings.length, 1, "the duplicate route is reported once as a warning")
eq(warnings[0]?.[0], "warn", "the duplicate route warning uses the warn level")

// Anything else from registerUpgrade still surfaces: the guard is narrow.
let otherThrew = null
try {
  plugin.apply(
    {
      webServer: {
        registerUpgrade: () => {
          throw new Error("webserver: something else broke")
        },
      },
      systemPrompt: { section: () => {} },
      tools: { register: () => {} },
      get: () => undefined,
    },
    { installSkill: false },
  )
} catch (error) {
  otherThrew = error
}
eq(otherThrew?.message, "webserver: something else broke", "unrelated registerUpgrade errors still propagate")

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

// ---------------------------------------------------------------------------
// 6. "面板连上了，但会话无法识别" — the bug this section pins.
//
//    A pty the user opened in the GUI panel must be visible to the model-facing
//    tools. Previously the panel and the tools could end up on two different
//    module instances with two different maps, so `ssh_remote action=status`
//    reported 0 sessions and exec answered "call action=connect first" while the
//    user was staring at a live terminal.
// ---------------------------------------------------------------------------
{
  const key = "panel@example.com:22"
  const fakeSession = {
    target: { user: "panel", host: "example.com", port: 22, key },
    controlPath: "/tmp/does-not-exist-panel.sock",
    cwd: "/srv/app",
  }
  terminalRegistry.set(key, {
    pty: { write() {}, kill() {}, resize() {} },
    buffer: "",
    subscribers: new Set(),
    target: fakeSession.target,
    session: fakeSession,
  })

  // status must list it, tagged as coming from the GUI panel.
  const status = await tools.ssh_remote.execute({ action: "status" }, {})
  eq(status.sessions.length, 1, "status lists the GUI-panel session")
  eq(status.sessions[0].key, key, "the listed key is the panel's target")
  eq(status.sessions[0].source, "gui-panel", "it is tagged source=gui-panel so the model knows where it came from")
  eq(status.sessions[0].cwd, "/srv/app", "its remote cwd is reported")
  ok(!/^no active ssh session/.test(status.message), "status does not claim there is no session")

  // A second copy of this module (the plugin-manager instance) sees the SAME map.
  const second = await import("../lib/index.js?instance=2")
  eq(second.__test__.terminalRegistry, terminalRegistry, "a second module instance shares one terminal registry")
  eq(second.__test__.sessions, sessions, "a second module instance shares one session map")

  // terminal_read / terminal_send resolve it without an explicit target.
  const read = await tools.ssh_terminal_read.execute({}, {})
  eq(read.ok, true, "ssh_terminal_read finds the panel terminal without a target")
  eq(read.length, 0, "an empty buffer reads back as an empty string, not an error")

  const sent = await tools.ssh_terminal_send.execute({ data: "uptime\r" }, {})
  eq(sent.ok, true, "ssh_terminal_send types into the panel terminal without a target")

  terminalRegistry.delete(key)
}

// ---------------------------------------------------------------------------
// 7. With nothing connected, status says so explicitly — the model must not be
//    left guessing whether "0 sessions" means empty or broken.
// ---------------------------------------------------------------------------
{
  eq(sessions.size, 0, "no model-connected sessions remain")
  eq(terminalRegistry.size, 0, "no panel terminals remain")
  const status = await tools.ssh_remote.execute({ action: "status" }, {})
  eq(status.sessions.length, 0, "status returns an empty list when nothing is connected")
  ok(/no active ssh session/i.test(status.message), "status explains there is no session instead of a bare count")
  ok(/GUI terminal panel/.test(status.message), "status tells the user the panel is an option")
}

// ---------------------------------------------------------------------------
// 8. Tool-name collisions must NOT take the whole plugin down.
//
//    DSH ships @deepseek-ai/dsh-tool-terminal, which already owns
//    terminal_open / terminal_send / terminal_read / terminal_signal /
//    terminal_close / terminal_list. `ctx.tools.register()` throws on a
//    duplicate name, and a throw inside apply() makes the host report the whole
//    entry as "did not activate" — the user then sees no ssh_remote tool at all
//    even though the WebSocket backend is perfectly healthy.
//
//    Two things are pinned here: our tools are named so they cannot collide,
//    and even if the host does report a duplicate, only that one tool is
//    skipped (with a warning) instead of aborting the rest of the plugin.
// ---------------------------------------------------------------------------
{
  const ourNames = Object.keys(tools)
  ok(ourNames.includes("ssh_remote"), "registers ssh_remote")
  ok(ourNames.includes("ssh_terminal_send"), "registers ssh_terminal_send")
  ok(ourNames.includes("ssh_terminal_read"), "registers ssh_terminal_read")

  // The names DSH's own terminal bundle reserves.
  const builtin = ["terminal_open", "terminal_send", "terminal_read", "terminal_signal", "terminal_close", "terminal_list"]
  for (const name of builtin) {
    ok(!ourNames.includes(name), `does not shadow the built-in tool "${name}"`)
  }

  // Simulate a host that already owns every name this plugin registers: apply()
  // must survive and still register what it can, warning instead of throwing.
  const collisions = new Set(["ssh_remote", "ssh_terminal_send", "ssh_terminal_read"])
  const warnings = []
  const captured = []
  let threw = null
  try {
    plugin.apply(
      {
        webServer: { registerUpgrade: () => {} },
        systemPrompt: { section: () => {} },
        tools: {
          register: (t) => {
            if (collisions.has(t.name)) throw new Error(`tool "${t.name}" is already registered`)
            captured.push(t.name)
          },
        },
        logger: (level) => (message) => warnings.push([level, message]),
        get: () => undefined,
      },
      { installSkill: false },
    )
  } catch (error) {
    threw = error
  }
  eq(threw, null, "a duplicate tool name does not fail apply()")
  eq(warnings.length, 3, "each skipped tool is reported once")
  eq(warnings[0]?.[0], "warn", "skipped tools are reported at warn level")
  ok(/already registered/.test(warnings[0]?.[1] || ""), "the warning names the duplicate reason")
  eq(captured.length, 0, "nothing was registered when every name collided")

  // An unrelated register() failure is still a real error: the guard is narrow.
  let otherThrew = null
  try {
    plugin.apply(
      {
        webServer: { registerUpgrade: () => {} },
        systemPrompt: { section: () => {} },
        tools: { register: () => { throw new Error("tool registry exploded") } },
        get: () => undefined,
      },
      { installSkill: false },
    )
  } catch (error) {
    otherThrew = error
  }
  eq(otherThrew?.message, "tool registry exploded", "unrelated registration errors still propagate")
}

process.exit(summary("terminal_test") ? 0 : 1)
