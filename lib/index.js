// dsh-ssh-shell: DSH plugin — password SSH into a remote host, keep a
// persistent ControlMaster session, and run remote shell commands.
//
// Cordis plugin contract: exports { name, inject, apply }. Registers one
// model-facing tool ("ssh_remote") plus a system-prompt section, paired with a
// companion SKILL.md under $DSH_HOME/skills.
//
// Flow (per the user's spec):
//   * connect — parse "ssh user@host [-p port]" + a one-shot password, build a
//     persistent OpenSSH ControlMaster via sshpass. CONNECTION IS NOT CONFIRMED.
//   * exec   — run one shell command on the live session, preserving the remote
//     cwd across calls. EVERY REMOTE COMMAND IS CONFIRMED before it is sent.
//     Foreground exec returns the complete output (a timeout still returns
//     everything captured so far). run_in_background streams output in real
//     time through the DSH jobs machinery (read increments with job_output).
//   * close / status — manage the persistent sessions.
//
// The cwd probe is emitted on ssh's STDERR (the remote command's own stderr is
// already merged into stdout via "2>&1"), so stdout carries the command output
// ONLY — clean for real-time streaming — while the probe is parsed off stderr.
//
// The password is used exactly once (inside the connect spawn) and is never
// written to disk or kept in memory afterwards. Only node builtins are used.

import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { defineTool } from "@deepseek-ai/dsh-tools"
import { WebSocketServer } from "ws"
import pty from "node-pty"

export const name = "ssh-shell"

export const inject = ["tools", "systemPrompt", "webServer"]

// Keep the ControlMaster alive until it dies on its own (remote host lost,
// sshd restart, or the DSH process exits). The old 600s default reaped the
// master after 10 idle minutes, which silently dropped the interactive pty and
// forced the user to re-type the password — the main "it keeps disconnecting"
// complaint.
const DEFAULT_CONTROL_PERSIST = "yes"
const DEFAULT_TIMEOUT_MS = 30000
const CONNECT_TIMEOUT_MS = 20000
// Idle TCP keepalive: NAT/firewalls and sshd itself drop quiet connections,
// which manifested as the terminal dying after a few quiet minutes. Applied to
// every long-lived connection (the master, and the interactive pty).
const KEEPALIVE_SSH_OPTS = [
  "-o", "ServerAliveInterval=30",
  "-o", "ServerAliveCountMax=3",
  "-o", "TCPKeepAlive=yes",
]
// A pty that dies while the master is still answering is respawned in place.
// Bounded so a loopily dropping ssh cannot spin forever.
const MAX_PTY_RESCUES = 3

/** Resolve the ControlPersist value from config: "yes", or a number of seconds. */
function controlPersistValue(config) {
  const raw = config && config.controlPersistSeconds
  if (raw == null || String(raw).trim() === "") return DEFAULT_CONTROL_PERSIST
  const n = Number(raw)
  return Number.isFinite(n) ? String(n) : String(raw).trim()
}

/**
 * Resolve the sshpass binary. The DSH process PATH often omits Homebrew's
 * prefix (e.g. /opt/homebrew/bin on Apple Silicon), so a bare "sshpass"
 * spawnSync fails with ENOENT. Probe the well-known absolute locations first.
 */
function resolveSshpass() {
  if (process.env.SSHPASS_BIN && process.env.SSHPASS_BIN.trim() !== "") {
    return process.env.SSHPASS_BIN
  }
  for (const candidate of [
    "/opt/homebrew/bin/sshpass",
    "/usr/local/bin/sshpass",
    "/opt/local/bin/sshpass",
    "/usr/bin/sshpass",
    "sshpass",
  ]) {
    const probe = spawnSync(candidate, ["-V"], { stdio: "ignore", timeout: 5000 })
    if (!probe.error) return candidate
  }
  return "sshpass"
}
const SSHPASS_BIN = resolveSshpass()

const CWD_BEGIN = "__DSH_SSH_CWD_BEGIN__"
const CWD_END = "__DSH_SSH_CWD_END__"

/** Active sessions keyed by canonical "user@host:port". */
const sessions = new Map()

/**
 * Live GUI-terminal PTYs, keyed by target.key. Lets the model talk to the
 * terminal the user has open in the GUI panel: terminal_send types into the
 * PTY, terminal_read returns the captured output (ANSI-scrubbed).
 *
 * Each entry holds one persistent pty plus a Set of attached WebSocket
 * subscribers. The pty outlives any single WebSocket connection: browser-side
 * unmount / hidden-panel / network blip no longer kills the interactive SSH.
 * Only an explicit "close" message (or the pty exiting on its own) tears it
 * down.
 */
const terminalRegistry = new Map()
let lastTerminalKey = null
const TERMINAL_BUFFER_MAX = 300000

/** Strip ANSI escape sequences so terminal_read returns readable text. */
function scrubAnsi(text) {
  return String(text)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[()][A-Z0-9]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
}

/** Resolve the terminal registry entry: explicit target, or the only/last one. */
function findTerminalRegistry(targetText) {
  if (typeof targetText === "string" && targetText.trim() !== "") {
    const t = parseTarget(targetText)
    return terminalRegistry.get(t.key) || null
  }
  if (terminalRegistry.size === 1) return [...terminalRegistry.values()][0]
  if (lastTerminalKey && terminalRegistry.has(lastTerminalKey)) {
    return terminalRegistry.get(lastTerminalKey)
  }
  return null
}

/** POSIX single-quote a shell word (handles embedded single quotes). */
function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

/** Parse "user@host [-p port]" (the ssh CLI shape the user types). */
function parseTarget(raw, explicitPort) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("target is required, e.g. \"root@1.2.3.4 -p 22\"")
  }
  let text = raw.trim()
  // 容忍用户习惯性输入 "ssh user@host [-p port]" 的 ssh 命令前缀
  text = text.replace(/^ssh\s+/i, "").trim()
  let port = explicitPort != null ? explicitPort : 22
  const pm = /(?:^|\s)-p\s*(\d{1,5})(?:\s|$)/.exec(text)
  if (pm) {
    port = Number(pm[1])
    text = text.replace(pm[0], " ").trim()
  }
  const at = text.indexOf("@")
  if (at <= 0) {
    throw new Error("target must look like \"user@host\"; got " + JSON.stringify(raw))
  }
  const user = text.slice(0, at).trim()
  const host = text.slice(at + 1).trim()
  if (user === "" || host === "") {
    throw new Error("target must look like \"user@host\"; got " + JSON.stringify(raw))
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("invalid port: " + port)
  }
  return { user: user, host: host, port: port, key: user + "@" + host + ":" + port }
}

/** Deterministic ControlPath per target so connect/exec/close agree. */
function controlPathFor(target, config) {
  // Unix domain sockets cap at ~104 bytes (macOS); ssh also appends a random
  // suffix to ControlPath. tmpdir() on macOS is /var/folders/.../T which is too
  // long once combined with the digest and ssh's suffix, so use ~/.dsh/ssh-shell.
  const dir = (typeof config.controlDir === "string" && config.controlDir.trim() !== "")
    ? config.controlDir
    : join(homedir(), ".dsh", "ssh-shell")
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const digest = createHash("sha1").update(target.key).digest("hex").slice(0, 12)
  return join(dir, digest + ".sock")
}

function baseSshArgs(target, controlPath) {
  return [
    "-o", "ControlMaster=no",
    "-o", "ControlPath=" + controlPath,
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "LogLevel=ERROR",
    "-p", String(target.port),
    target.user + "@" + target.host,
  ]
}

/** Run one command on the persistent master socket synchronously (connect probe, close). */
function execRemoteSync(target, controlPath, remoteScript, timeoutMs) {
  const args = baseSshArgs(target, controlPath)
  args.push("--", remoteScript)
  const result = spawnSync("ssh", args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  })
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    code: result.error ? 255 : (result.status == null ? 255 : result.status),
    error: result.error ? String(result.error) : null,
  }
}

/**
 * True when the ControlMaster behind a session still answers. Uses `ssh -O
 * check`, which is cheaper than opening a muxed connection and never blocks the
 * event loop for long.
 */
function probeMasterAlive(session) {
  if (!session || !session.controlPath) return false
  let hasSocket = false
  try { hasSocket = existsSync(session.controlPath) } catch { hasSocket = false }
  if (!hasSocket) return false
  const r = spawnSync(
    "ssh",
    baseSshArgs(session.target, session.controlPath).concat(["-O", "check"]),
    { encoding: "utf8", timeout: 3000 },
  )
  return !r.error && r.status === 0
}

/**
 * Wrap a remote command. The remote command's stderr merges into stdout via
 * "2>&1"; the cwd probe prints to STDERR so stdout stays pure command output.
 */
function wrapRemoteScript(command, cwd) {
  let cd = ""
  if (cwd && cwd.trim() !== "") {
    cd = "cd " + shq(cwd) + " 2>/dev/null || :; "
  }
  return "{ " + cd + command + "; } 2>&1; __ec=$?; " +
    "printf '" + CWD_BEGIN + "\\n%s\\n" + CWD_END + "\\n' \"$PWD\" >&2; exit $__ec"
}

/** Pull the cwd probe out of ssh stderr; returns { cwd, rest } (rest = other stderr). */
function extractCwdFromStderr(stderr) {
  const re = new RegExp(CWD_BEGIN + "\\n([\\s\\S]*?)\\n" + CWD_END)
  const m = re.exec(stderr)
  if (!m) return { cwd: null, rest: stderr }
  const cwd = m[1].trim()
  // NOTE: the regex must be /\s/, not /\\s/ — the latter matches a literal
  // backslash followed by "s" and silently never trims anything, leaving
  // newlines from the probe framing in the stderr handed back to the model.
  const rest = (stderr.slice(0, m.index) + stderr.slice(m.index + m[0].length)).replace(/^\s+|\s+$/g, "")
  return { cwd: cwd === "" ? null : cwd, rest: rest }
}

/** Ask the user to confirm a remote command via the DSH approval seam (fail closed). */
async function confirmRemoteCommand(ctx, exec, reason) {
  const approval = ctx.get("approval")
  if (!approval) {
    throw new Error("ssh_remote: no approval service mounted; refusing to run a remote command without confirmation")
  }
  if (!exec.agent) {
    throw new Error("ssh_remote: cannot confirm a remote command outside an agent turn")
  }
  const outcome = await approval.request({
    agent: exec.agent,
    toolName: "ssh_remote",
    reason: reason,
    signal: exec.signal,
  })
  if (outcome !== "allowed-once") {
    throw new Error("remote command NOT sent (approval outcome: " + outcome + ")")
  }
}

/** Synchronous sleep (Atomics.wait is available on the main thread). */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Poll until the ControlMaster socket file appears (or timeout). */
function waitForControlSocket(controlPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { if (existsSync(controlPath)) return true } catch {}
    sleepSync(200)
  }
  return existsSync(controlPath)
}

/** Establish a persistent ControlMaster via sshpass; returns { controlPath, cwd }. Throws on failure. */
function establishMaster(target, password, config) {
  const controlPath = controlPathFor(target, config)
  const persist = controlPersistValue(config)
  const masterArgs = [
    "-p", password,
    "ssh",
    "-o", "ControlMaster=yes",
    "-o", "ControlPath=" + controlPath,
    "-o", "ControlPersist=" + persist,
    ...KEEPALIVE_SSH_OPTS,
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=10",
    "-o", "LogLevel=ERROR",
    "-f", "-N",
    "-p", String(target.port),
    target.user + "@" + target.host,
  ]
  const started = spawnSync(SSHPASS_BIN, masterArgs, { encoding: "utf8", timeout: CONNECT_TIMEOUT_MS })
  if (started.error) {
    throw new Error("sshpass (" + SSHPASS_BIN + ") failed to start: " + String(started.error) + " (PATH=" + process.env.PATH + ")")
  }
  if (started.status !== 0) {
    const detail = (started.stderr || started.stdout || "").trim() || ("exit " + started.status)
    throw new Error("ssh connect failed for " + target.key + " (via " + SSHPASS_BIN + "): " + detail)
  }
  // ssh -f forks to the background before authenticating, so sshpass returns
  // before the ControlMaster socket exists. Wait for the socket, then probe
  // (with retries) to ride out the socket-just-created window.
  waitForControlSocket(controlPath, 8000)
  let probe = execRemoteSync(target, controlPath, "pwd", CONNECT_TIMEOUT_MS)
  for (let attempt = 0; (probe.error || probe.code !== 0) && attempt < 5; attempt++) {
    sleepSync(500)
    probe = execRemoteSync(target, controlPath, "pwd", CONNECT_TIMEOUT_MS)
  }
  if (probe.error || probe.code !== 0) {
    try { spawnSync("ssh", baseSshArgs(target, controlPath).concat(["-O", "exit"]), { encoding: "utf8", timeout: 5000 }) } catch {}
    throw new Error("ssh connect failed for " + target.key + " (probe): " + (probe.stderr || probe.stdout || probe.error) + " | socket=" + controlPath + " exists=" + existsSync(controlPath))
  }
  const cwd = probe.stdout.trim().split("\n").pop() || ""
  return { controlPath: controlPath, cwd: cwd }
}

/**
 * Interactive terminal over WebSocket. A node-pty (real local PTY) runs
 * ssh -tt on the persistent ControlMaster, so raw mode, Ctrl+C, arrows,
 * full-screen programs (vim/top) and SIGWINCH resize all work; the PTY's
 * bytes are bidirectionally bridged to the browser socket.
 *
 * The pty is a target-keyed singleton stored in terminalRegistry, shared by
 * every attached WebSocket. Closing one socket does NOT kill the pty — that is
 * what made "hide panel = drop SSH" before. A pty only dies when the browser
 * explicitly sends type:"close", or when the remote shell exits.
 */
function attachPtyToWebSocket(ws, targetKey, send) {
  const entry = terminalRegistry.get(targetKey)
  if (!entry) return false
  entry.subscribers.add(ws)
  // Send current buffer so a late-attaching client catches up on history.
  send({ type: "output", data: entry.buffer })
  send({ type: "status", state: "attached", message: "attached to existing pty for " + targetKey })
  return true
}

function detachPtyFromWebSocket(ws, targetKey) {
  const entry = terminalRegistry.get(targetKey)
  if (entry) entry.subscribers.delete(ws)
}

function createTerminalPty(target, session, initialCols, initialRows) {
  const sshArgs = [
    "-tt",
    "-o", "ControlMaster=no",
    "-o", "ControlPath=" + session.controlPath,
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    ...KEEPALIVE_SSH_OPTS,
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "LogLevel=ERROR",
    "-p", String(target.port),
    target.user + "@" + target.host,
  ]
  const cols = Number(initialCols) || 80
  const rows = Number(initialRows) || 24
  const ptyProc = pty.spawn("ssh", sshArgs, {
    name: "xterm-256color",
    cols: cols,
    rows: rows,
    env: { ...process.env, TERM: "xterm-256color", LANG: process.env.LANG || "en_US.UTF-8" },
  })
  const entry = {
    pty: ptyProc,
    buffer: "",
    subscribers: new Set(),
    target: target,
    session: session,
  }
  terminalRegistry.set(target.key, entry)
  ptyProc.onData((d) => {
    entry.buffer = (entry.buffer + d).slice(-TERMINAL_BUFFER_MAX)
    const payload = { type: "output", data: d }
    for (const sub of entry.subscribers) {
      if (sub.readyState === 1) {
        try { sub.send(JSON.stringify(payload)) } catch {}
      }
    }
  })
  ptyProc.onExit((e) => {
    // The remote shell exited. Two very different causes:
    //   (a) the master is still answering — usually a transient ssh drop, so
    //       respawn the pty in place and carry the same subscribers over;
    //   (b) the master is gone — the session has really ended, notify clients.
    if (session && Number(session.ptyRescues || 0) < MAX_PTY_RESCUES && probeMasterAlive(session)) {
      session.ptyRescues = Number(session.ptyRescues || 0) + 1
      const fresh = createTerminalPty(target, session, initialCols, initialRows)
      for (const sub of entry.subscribers) fresh.subscribers.add(sub)
      const payload = {
        type: "status",
        state: "recovered",
        message: "远端 shell 意外中断，已自动恢复（第 " + session.ptyRescues + " 次）",
      }
      for (const sub of entry.subscribers) {
        if (sub.readyState === 1) {
          try { sub.send(JSON.stringify(payload)) } catch {}
        }
      }
      return
    }
    terminalRegistry.delete(target.key)
    const payload = {
      type: "exit",
      exitCode: e.exitCode ?? 0,
      signal: e.signal ?? null,
      recoverable: probeMasterAlive(session),
    }
    for (const sub of entry.subscribers) {
      if (sub.readyState === 1) {
        try { sub.send(JSON.stringify(payload)) } catch {}
      }
    }
  })
  return entry
}

function handleTerminalConnection(ws, ctx, config) {
  let currentKey = null
  const send = (obj) => { if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)) } catch {} } }

  // Idle-socket watchdog. Quiet WebSockets get dropped by proxies and by the
  // browser itself, and the client used to take that as "session lost". Ping
  // every 25s and terminate anything that has not answered within 60s. Killing
  // a dead socket only detaches this client — the pty keeps running, which is
  // what makes automatic re-attach possible.
  let lastPong = Date.now()
  ws.on("pong", () => { lastPong = Date.now() })
  const keepAlive = setInterval(() => {
    if (ws.readyState !== 1) { clearInterval(keepAlive); return }
    if (Date.now() - lastPong > 60000) {
      clearInterval(keepAlive)
      try { ws.terminate() } catch {}
      return
    }
    try { ws.ping() } catch {}
  }, 25000)

  ws.on("message", (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }
    if (msg.type === "connect") {
      try {
        const target = parseTarget(msg.target, msg.port)
        const existing = terminalRegistry.get(target.key)
        if (existing && existing.pty) {
          // Reuse a live pty. If the caller supplied credentials, ignore them;
          // if the existing pty belongs to the same target it is by definition
          // already connected.
          currentKey = target.key
          lastTerminalKey = target.key
          if (existing.session) existing.session.ptyRescues = 0
          attachPtyToWebSocket(ws, target.key, send)
          return
        }
        let session = sessions.get(target.key)
        // Drop a session whose ControlMaster has already been reaped —
        // otherwise createTerminalPty would spawn an ssh that exits instantly.
        if (session && !probeMasterAlive(session)) {
          sessions.delete(target.key)
          session = null
        }
        if (!session) {
          if (typeof msg.password !== "string" || msg.password === "") {
            send({ type: "status", state: "error", message: "SSH 会话已过期，需要重新输入密码" })
            return
          }
          const est = establishMaster(target, msg.password, config)
          session = { target: target, controlPath: est.controlPath, cwd: est.cwd, ptyRescues: 0 }
          sessions.set(target.key, session)
        }
        const entry = createTerminalPty(target, session, msg.cols, msg.rows)
        session.ptyRescues = 0
        currentKey = target.key
        lastTerminalKey = target.key
        entry.subscribers.add(ws)
        send({ type: "status", state: "connected", message: "connected to " + target.key + " (interactive pty)" })
      } catch (err) {
        send({ type: "status", state: "error", message: err && err.message ? err.message : String(err) })
      }
    } else if (msg.type === "input") {
      if (!currentKey) {
        // Some flows send input without a prior attach on this ws. Resolve
        // lazily against the registry so it still works.
        currentKey = lastTerminalKey
      }
      const entry = currentKey ? terminalRegistry.get(currentKey) : null
      if (entry && entry.pty && typeof msg.data === "string") {
        try { entry.pty.write(msg.data) } catch {}
      }
    } else if (msg.type === "resize") {
      const key = currentKey || lastTerminalKey
      const entry = key ? terminalRegistry.get(key) : null
      if (entry && entry.pty) {
        try { entry.pty.resize(Number(msg.cols) || 80, Number(msg.rows) || 24) } catch {}
      }
    } else if (msg.type === "close") {
      // Explicit user intent to disconnect: kill the pty for this target.
      const key = currentKey || lastTerminalKey
      const entry = key ? terminalRegistry.get(key) : null
      if (entry) {
        try { entry.pty.kill() } catch {}
        terminalRegistry.delete(key)
        send({ type: "status", state: "closed", message: "closed pty for " + key })
      }
      currentKey = null
      // Close our socket too; the pty is already gone.
      try { ws.close() } catch {}
    }
  })
  // A ws closing does NOT kill the pty — the browser may just be hiding the
  // panel, refreshing, or the tab may have backgrounded. The pty survives
  // until an explicit "close" or the remote shell exits.
  ws.on("close", () => {
    clearInterval(keepAlive)
    if (currentKey) detachPtyFromWebSocket(ws, currentKey)
  })
  ws.on("error", () => {})
}

function presentTerminal(title, output) {
  return { card: "terminal", title: title, output: output }
}

function formatResult(value) {
  const lines = [value.message || ""]
  if (typeof value.stdout === "string" && value.stdout !== "") {
    lines.push("", value.stdout.replace(/\n+$/, ""))
  }
  if (typeof value.stderr === "string" && value.stderr !== "") {
    lines.push("", "[stderr]", value.stderr.replace(/\n+$/, ""))
  }
  if (value.timedOut) lines.push("[timed out; output above is everything captured before timeout]")
  if (value.exitCode != null && value.exitCode !== 0) {
    lines.push("[exit code: " + value.exitCode + "]")
  }
  return lines.join("\n")
}

export function apply(ctx, config = {}) {
  const defaultTimeout = Number(config.timeoutMs || DEFAULT_TIMEOUT_MS)

  // Interactive terminal WebSocket (browser <-> ssh pty).
  ctx.webServer.registerUpgrade({
    path: "/ssh-terminal",
    handler: (req, socket, head) => {
      const wss = new WebSocketServer({ noServer: true })
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleTerminalConnection(ws, ctx, config)
      })
    },
  })

  ctx.systemPrompt.section({
    name: "tool:ssh_remote",
    order: 106,
    text: [
      "Use the ssh_remote tool to reach a remote host over password SSH.",
      "The user gives connection info in ssh-cli shape, e.g. \"ssh root@1.2.3.4 -p 22\" (port defaults to 22) plus the password; call action=connect once.",
      "Connection is NOT confirmed. Every remote command (action=exec) IS confirmed by the user before it is sent — write the exact command in your answer, then let the tool prompt for approval.",
      "For long-running or streaming remote commands (logs, builds, deploys), pass run_in_background: true so output streams in real time; read it incrementally with job_output and stop it with job_kill.",
      "The session is persistent: the remote cwd carries across foreground exec calls.",
      "If the user has a terminal open in the GUI terminal panel, do NOT use ssh_remote exec (its approval is often disabled).",
      "Instead use terminal_send to type commands into that live terminal (e.g. terminal_send data: \"x-ui\\r\") and terminal_read to read its output — direct interaction with the user's connected session, no per-command confirmation.",
    ].join(" "),
  })

  ctx.tools.register(defineTool({
    name: "ssh_remote",
    description: [
      "Manage a persistent password-SSH session to a remote host and run commands there.",
      "connect: establish the connection (parses \"ssh user@host [-p port]\" + password). Not confirmed.",
      "exec: run one shell command on the live session; the remote working directory persists across calls. Confirmed with the user before the command is sent.",
      "exec with run_in_background: true returns a job id immediately and streams output in real time — read increments with job_output, stop with job_kill.",
      "close: tear down a session. status: list active sessions.",
      "Passwords are one-shot and never stored on disk.",
    ].join(" "),
    parameters: {
      action: {
        type: "string",
        required: true,
        enum: ["connect", "exec", "close", "status"],
        description: "Which operation to perform.",
      },
      target: {
        type: "string",
        description: "Connection target in ssh-cli shape: \"user@host -p port\" (port defaults to 22). Required for connect/exec/close.",
      },
      port: {
        type: "number",
        description: "Optional explicit port; overrides any -p in target.",
      },
      password: {
        type: "string",
        description: "Password for the remote user. Required only for connect; used once and never persisted.",
      },
      command: {
        type: "string",
        description: "The shell command to run on the remote host. Required for exec.",
      },
      timeoutMs: {
        type: "number",
        description: "Foreground per-call timeout in milliseconds (default 30000). Ignored when run_in_background is true.",
      },
      run_in_background: {
        type: "boolean",
        description: "Run the remote command in the background and return a job id immediately. Output streams in real time (collect with job_output, stop with job_kill). No timeout applies.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          message: { type: "string", required: true },
          cwd: { type: "string" },
          stdout: { type: "string" },
          stderr: { type: "string" },
          exitCode: { type: "integer" },
          timedOut: { type: "boolean" },
          sessions: { type: "array" },
        },
      },
      render: (_args, value) => [{ type: "text", text: formatResult(value) }],
    },
    async execute(args, exec) {
      const action = args.action

      if (action === "status") {
        const list = []
        for (const [key, s] of sessions) {
          list.push({ key: key, host: s.target.host, user: s.target.user, port: s.target.port, cwd: s.cwd, controlPath: s.controlPath })
        }
        return { ok: true, message: sessions.size + " active ssh session(s)", sessions: list }
      }

      if (action === "connect") {
        const target = parseTarget(args.target, args.port)
        const password = args.password
        if (typeof password !== "string" || password === "") {
          throw new Error("connect requires a non-empty password")
        }
        const est = establishMaster(target, password, config)
        sessions.set(target.key, { target: target, controlPath: est.controlPath, cwd: est.cwd })
        return {
          ok: true,
          message: "connected to " + target.key + " (persistent session, cwd=" + est.cwd + ")",
          cwd: est.cwd,
          stdout: est.cwd,
        }
      }

      if (action === "exec") {
        const command = args.command
        if (typeof command !== "string" || command.trim() === "") {
          throw new Error("exec requires a non-empty command")
        }
        const target = parseTarget(args.target, args.port)
        let session = sessions.get(target.key)
        if (!session) {
          throw new Error("no active session for " + target.key + "; call action=connect first")
        }
        if (!probeMasterAlive(session)) {
          sessions.delete(target.key)
          throw new Error(
            "remote session for " + target.key + " has expired (ControlMaster socket gone); " +
              "call action=connect with the password again",
          )
        }

        await confirmRemoteCommand(
          ctx, exec,
          "Run on remote " + target.key + " (cwd " + (session.cwd || "~") + "):\n$ " + command,
        )

        const script = wrapRemoteScript(command, session.cwd)
        const sshArgs = baseSshArgs(target, session.controlPath).concat(["--", script])

        if (args.run_in_background === true) {
          const jobs = ctx.get("jobs")
          if (!jobs) {
            throw new Error("background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs")
          }
          const jobId = jobs.start({
            kind: "ssh_remote",
            label: command,
            ...(exec.agent ? { owner: exec.agent } : {}),
            run: () => {
              const proc = spawn("ssh", sshArgs, { stdio: ["ignore", "pipe", "pipe"] })
              let delta = ""
              let stderrBuf = ""
              proc.stdout.setEncoding("utf8")
              proc.stderr.setEncoding("utf8")
              proc.stdout.on("data", (d) => { delta += d })
              proc.stderr.on("data", (d) => { stderrBuf += d })
              let resolveDone
              const done = new Promise((r) => { resolveDone = r })
              proc.on("close", (code, signal) => {
                const ex = extractCwdFromStderr(stderrBuf)
                if (ex.cwd) session.cwd = ex.cwd
                if (ex.rest) delta += "[ssh] " + ex.rest + "\n"
                resolveDone({
                  status: signal ? "killed" : "completed",
                  detail: signal ? ("signal: " + signal) : ("exit code: " + (code ?? 0)),
                })
              })
              proc.on("error", (err) => {
                resolveDone({ status: "failed", detail: String(err) })
              })
              return {
                cancel: () => { try { proc.kill("SIGKILL") } catch {} },
                done: done,
                readOutput: () => { const t = delta; delta = ""; return t },
              }
            },
          })
          return { ok: true, message: "started background job " + jobId + " — stream output with job_output", exitCode: 0 }
        }

        const timeoutMs = Number(args.timeoutMs || defaultTimeout)
        const proc = spawn("ssh", sshArgs, { stdio: ["ignore", "pipe", "pipe"] })
        let stdout = ""
        let stderr = ""
        let timedOut = false
        proc.stdout.setEncoding("utf8")
        proc.stderr.setEncoding("utf8")
        proc.stdout.on("data", (d) => { stdout += d })
        proc.stderr.on("data", (d) => { stderr += d })
        const timer = setTimeout(() => { timedOut = true; try { proc.kill("SIGKILL") } catch {} }, timeoutMs)
        const code = await new Promise((resolve) => {
          proc.on("close", (c) => { clearTimeout(timer); resolve(c ?? 255) })
          proc.on("error", () => { clearTimeout(timer); resolve(255) })
        })
        const ex = extractCwdFromStderr(stderr)
        if (ex.cwd) session.cwd = ex.cwd
        const finalStderr = ex.rest

        const ret = {
          ok: code === 0 && !timedOut,
          message: timedOut
            ? "remote command timed out after " + timeoutMs + "ms (partial output returned)"
            : (code === 0 ? "remote command finished (exit " + code + ")" : "remote command finished with exit " + code),
          cwd: session.cwd,
          stdout: stdout,
          exitCode: code,
        }
        if (timedOut) ret.timedOut = true
        if (finalStderr && finalStderr.trim() !== "") ret.stderr = finalStderr
        return ret
      }

      if (action === "close") {
        const target = parseTarget(args.target, args.port)
        const session = sessions.get(target.key)
        if (!session) {
          return { ok: true, message: "no active session for " + target.key }
        }
        try {
          spawnSync("ssh", baseSshArgs(target, session.controlPath).concat(["-O", "exit"]), { encoding: "utf8", timeout: 5000 })
        } catch {}
        sessions.delete(target.key)
        return { ok: true, message: "closed session " + target.key }
      }

      throw new Error("unknown action: " + action)
    },
    presentCall: (args) => {
      if (args.action === "connect") return presentTerminal("ssh " + (args.target || ""), "")
      if (args.action === "exec") {
        const title = (args.run_in_background === true ? "[remote, background] " : "[remote] ") + (args.command || "")
        return presentTerminal(title, "")
      }
      return presentTerminal("ssh_remote " + args.action, "")
    },
    presentResult: (_args, value) => presentTerminal(value.message || "done", typeof value.stdout === "string" ? value.stdout : ""),
  }))

  // --- terminal bridge: the model types directly into the GUI terminal's PTY ---
  ctx.tools.register(defineTool({
    name: "terminal_send",
    description: [
      "Type keystrokes directly into the SSH terminal the user has open in the GUI terminal panel (a real interactive PTY).",
      "This types into the live session with NO per-command confirmation — the user already authorized direct terminal interaction.",
      "Append \\r to press Enter (e.g. data: \"x-ui\\r\"). Use \\x03 for Ctrl+C, \\x1b[A for Up arrow.",
      "Use terminal_read afterwards to see the response.",
    ].join(" "),
    parameters: {
      target: {
        type: "string",
        description: 'Optional target "user@host -p port". Defaults to the only/last connected terminal.',
      },
      data: {
        type: "string",
        required: true,
        description: 'Keystrokes to type into the terminal, e.g. "x-ui\\r" (\\r = Enter).',
      },
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: (value && value.message) || "sent" }],
    },
    async execute(args, _exec) {
      const reg = findTerminalRegistry(args.target)
      if (!reg) {
        throw new Error(
          "no active terminal" + (args.target ? " for " + args.target : "") +
            "; the user must connect in the GUI terminal panel first (the session may have expired)",
        )
      }
      const data = String(args.data ?? "")
      if (data === "") throw new Error("data is required (keystrokes to type)")
      try {
        reg.pty.write(data)
      } catch (err) {
        throw new Error("terminal write failed: " + (err && err.message ? err.message : String(err)))
      }
      return { ok: true, message: "typed " + JSON.stringify(data) + " into terminal " + (args.target || "(default)") }
    },
  }))

  ctx.tools.register(defineTool({
    name: "terminal_read",
    description: [
      "Read the recent output of the SSH terminal connected in the GUI terminal panel (prompt + command results).",
      "The output is ANSI-scrubbed plain text. Use after terminal_send to see what the remote printed.",
      "Pass clear: true to consume the buffer (incremental reads).",
    ].join(" "),
    parameters: {
      target: {
        type: "string",
        description: 'Optional target "user@host -p port". Defaults to the only/last connected terminal.',
      },
      clear: {
        type: "boolean",
        description: "If true, clear the captured buffer after reading. Default false.",
      },
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: (value && value.output) || "" }],
    },
    async execute(args, _exec) {
      const reg = findTerminalRegistry(args.target)
      if (!reg) {
        throw new Error(
          "no active terminal" + (args.target ? " for " + args.target : "") +
            "; the user must connect in the GUI terminal panel first (the session may have expired)",
        )
      }
      const out = scrubAnsi(reg.buffer)
      if (args.clear === true) reg.buffer = ""
      return { ok: true, output: out, length: out.length }
    },
  }))
}

export default { name, inject, apply }

// Internal surface for the test suite (tests/*.mjs). These are the plugin's
// pure helpers, re-exported so they can be exercised directly without spinning
// up a whole DSH host. Nothing here is part of the public plugin contract —
// it is deliberately a separate named export so `export default` stays the
// Cordis entry point.
export const __test__ = {
  parseTarget,
  controlPathFor,
  controlPersistValue,
  wrapRemoteScript,
  extractCwdFromStderr,
  stripAnsi: scrubAnsi,
  resolveSshpass,
  shq,
  sessions,
  terminalRegistry,
  attachPtyToWebSocket,
  detachPtyFromWebSocket,
  CWD_BEGIN,
  CWD_END,
  KEEPALIVE_SSH_OPTS,
  DEFAULT_CONTROL_PERSIST,
  DEFAULT_TIMEOUT_MS,
  MAX_PTY_RESCUES,
}
