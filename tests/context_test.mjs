// Tests for the per-turn session snapshot — the fix for "已经连上了，你为什么查不到".
//
// The prompt section tells the model to call ssh_remote action=status first, but
// that only helps if the model thinks to look. The context below is assembled on
// every request, so a live panel session is simply *there* in the prompt: no
// tool call, no guessing, no asking the user for a password they already typed.
//
//   node tests/context_test.mjs

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { apply, __test__ } from "../lib/index.js"
import { eq, ok, summary } from "./helpers.mjs"

const { describeLiveSessions, sessions, terminalRegistry } = __test__

console.log("context_test: per-turn session snapshot\n")

const tmp = mkdtempSync(join(tmpdir(), "dsh-ssh-shell-ctx-"))
const liveSocket = join(tmp, "live.sock")
writeFileSync(liveSocket, "")
const deadSocket = join(tmp, "dead.sock")

function reset() {
  sessions.clear()
  terminalRegistry.clear()
}

// ---- nothing live: no context at all, so an idle plugin costs zero tokens ----
reset()
eq(describeLiveSessions(), [], "no sessions means an empty snapshot")
{
  let registered = null
  apply(
    {
      logger: () => ({ warn(){}, info(){}, error(){}, debug(){}, verbose(){} }),
      webServer: { registerUpgrade(){} },
      systemPrompt: { section(){}, context: (c) => { registered = c } },
      tools: { register(){} },
      get: () => undefined,
    },
    { installSkill: false },
  )
  eq(registered?.name, "ssh-shell:sessions", "apply() registers the session snapshot context")
  eq(typeof registered.text, "function", "the snapshot is a function, so it is re-evaluated every request")
  eq(registered.interpolate, false, "the snapshot is not variable-interpolated (cwds may contain braces)")
  eq(registered.text(), "", "an idle plugin contributes an empty context")
}

// ---- a panel session (the user connected from the right-edge 终端 tab) ----
reset()
const panelTarget = { key: "root@10.0.0.9:22222", user: "root", host: "10.0.0.9", port: 22222 }
terminalRegistry.set(panelTarget.key, {
  pty: { write() {}, resize() {}, kill() {} },
  buffer: "",
  subscribers: new Set(),
  target: panelTarget,
  session: { target: panelTarget, controlPath: liveSocket, cwd: "/root", ptyRescues: 0 },
})
const panelLines = describeLiveSessions()
eq(panelLines.length, 1, "one panel session produces one line")
ok(panelLines[0].includes(panelTarget.key), "the line names the canonical target")
ok(/panel \(source: "gui-panel"\)/.test(panelLines[0]), "the line is tagged as a panel session")
ok(panelLines[0].includes("cwd=/root"), "the line carries the remote cwd")

// ---- a session the model opened itself ----
reset()
sessions.set(panelTarget.key, { target: panelTarget, controlPath: liveSocket, cwd: "/srv/app" })
const mine = describeLiveSessions()
eq(mine.length, 1, "one self-opened session produces one line")
ok(/yours \(ssh_remote\)/.test(mine[0]), "the line is tagged as model-owned")
ok(mine[0].includes("cwd=/srv/app"), "the line carries the remote cwd")

// ---- a reaped ControlMaster must not be advertised ----
reset()
sessions.set(panelTarget.key, { target: panelTarget, controlPath: deadSocket, cwd: "/root" })
eq(describeLiveSessions(), [], "a session whose ControlMaster socket is gone is not advertised")

// ---- same target in both maps: the panel wins, and it appears once ----
reset()
terminalRegistry.set(panelTarget.key, {
  pty: { write() {}, resize() {}, kill() {} },
  buffer: "",
  subscribers: new Set(),
  target: panelTarget,
  session: { target: panelTarget, controlPath: liveSocket, cwd: "/root" },
})
sessions.set(panelTarget.key, { target: panelTarget, controlPath: liveSocket, cwd: "/root" })
const deduped = describeLiveSessions()
eq(deduped.length, 1, "a target in both registries is reported once")
ok(/panel/.test(deduped[0]), "the panel label wins, because that is the session the user is looking at")

// ---- a pty whose process died is not advertised ----
reset()
terminalRegistry.set(panelTarget.key, {
  pty: null,
  buffer: "",
  subscribers: new Set(),
  target: panelTarget,
  session: { target: panelTarget, controlPath: liveSocket, cwd: "/root" },
})
eq(describeLiveSessions(), [], "a terminal entry without a live pty is not advertised")

// ---- the rendered context ----
reset()
terminalRegistry.set(panelTarget.key, {
  pty: { write() {}, resize() {}, kill() {} },
  buffer: "",
  subscribers: new Set(),
  target: panelTarget,
  session: { target: panelTarget, controlPath: liveSocket, cwd: "/root" },
})
let ctxEntry = null
apply(
  {
    logger: () => ({ warn(){}, info(){}, error(){}, debug(){}, verbose(){} }),
    webServer: { registerUpgrade(){} },
    systemPrompt: { section(){}, context: (c) => { ctxEntry = c } },
    tools: { register(){} },
    get: () => undefined,
  },
  { installSkill: false },
)
const rendered = ctxEntry.text()
ok(rendered.includes("## SSH sessions"), "the context has a heading the model can anchor on")
ok(rendered.includes(panelTarget.key), "the context names the live target")
ok(/already authenticated/.test(rendered), "the context says a panel session needs no password")
ok(/ssh_terminal_send/.test(rendered), "the context points at the right tool")

// ---- an older host without systemPrompt.context must not break the plugin ----
reset()
let threw = null
try {
  apply(
    {
      logger: () => ({ warn(){}, info(){}, error(){}, debug(){}, verbose(){} }),
      webServer: { registerUpgrade(){} },
      systemPrompt: { section(){} },
      tools: { register(){} },
      get: () => undefined,
    },
    { installSkill: false },
  )
} catch (error) {
  threw = error
}
eq(threw, null, "a host without systemPrompt.context() still loads the plugin")

reset()
rmSync(tmp, { recursive: true, force: true })

process.exit(summary("context_test") ? 0 : 1)
