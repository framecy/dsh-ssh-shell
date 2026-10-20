// Unit tests for the plugin's pure logic — no ssh, no network, no PTY.
//
// These cover the pieces that are easy to get subtly wrong and expensive to
// debug in production: target parsing (the user types ssh CLI shape), the
// shell-quoting used to build the remote script, the cwd-probe framing that
// keeps stdout clean for streaming, and the ControlPath length constraint that
// silently breaks ControlMaster when violated.
//
//   node tests/core_test.mjs

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __test__ } from "../lib/index.js"
import { eq, ok, throws, summary } from "./helpers.mjs"

const {
  parseTarget,
  controlPathFor,
  controlPersistValue,
  wrapRemoteScript,
  extractCwdFromStderr,
  stripAnsi: stripAnsi,
  shq,
  CWD_BEGIN,
  CWD_END,
  sharedState,
  bundledSkillPath,
  dshSkillsDir,
  installSkill,
} = __test__

console.log("core_test: pure logic\n")

// ---- parseTarget: the "ssh user@host [-p port]" shape the user actually types ----
eq(parseTarget("root@1.2.3.4"), { user: "root", host: "1.2.3.4", port: 22, key: "root@1.2.3.4:22" }, "bare user@host defaults to port 22")
eq(parseTarget("root@1.2.3.4 -p 2222").port, 2222, "explicit -p sets the port")
eq(parseTarget(" ssh root@1.2.3.4 -p 22 ").user, "root", "tolerates a pasted 'ssh ' prefix and surrounding spaces")
eq(parseTarget("root@1.2.3.4", 2222).port, 2222, "explicit port argument wins over the default")
eq(parseTarget("deploy@example.com -p 22").host, "example.com", "accepts a DNS host")
eq(parseTarget("ssh -p 2222 root@1.2.3.4").port, 2222, "tolerates -p before the target, as ssh itself allows")

throws(() => parseTarget(""), "empty target is rejected")
throws(() => parseTarget("justahost"), "target without @ is rejected")
throws(() => parseTarget("@1.2.3.4"), "target without a user is rejected")
throws(() => parseTarget("root@"), "target without a host is rejected")
throws(() => parseTarget("root@1.2.3.4 -p 99999"), "out-of-range port is rejected")
throws(() => parseTarget("root@1.2.3.4 -p 0"), "port 0 is rejected")

// ---- shq: POSIX single-quoting, the injection boundary for remote commands ----
eq(shq("simple"), "'simple'", "plain word is wrapped in single quotes")
eq(shq("a'b"), "'a'\\''b'", "embedded single quote is escaped, not left to break out")
eq(shq("; rm -rf /"), "'; rm -rf /'", "shell metacharacters stay inert inside quotes")
eq(shq("$(whoami)"), "'$(whoami)'", "command substitution is not evaluated")
eq(shq("a b\tc"), "'a b\tc'", "spaces and tabs are preserved as one word")

// ---- wrapRemoteScript: stdout must carry command output ONLY (stderr merges in;
//      the cwd probe rides on stderr) so run_in_background streaming stays clean ----
{
  const s = wrapRemoteScript("ls -la", null)
  ok(s.includes("ls -la"), "script contains the user's command")
  ok(s.includes(CWD_BEGIN) && s.includes(CWD_END), "script carries the cwd probe markers")
  ok(s.includes(">&2"), "cwd probe is emitted on stderr, keeping stdout clean")
  ok(s.includes("2>&1"), "command stderr is merged into stdout")
  ok(s.includes("exit $__ec"), "script propagates the command's exit code")
  ok(!s.includes("cd "), "no cd when no cwd is requested")
}
{
  const s = wrapRemoteScript("pwd", "/var/log")
  ok(s.includes("cd '/var/log'"), "cwd is applied with quoting when given")
  ok(s.includes("|| :"), "a stale cwd degrades to the default instead of failing the command")
}
{
  const s = wrapRemoteScript("pwd", "/tmp/it's")
  ok(s.includes("'\\''"), "cwd containing a quote is escaped")
}

// ---- extractCwdFromStderr: parse the probe back out, leave other stderr intact ----
{
  const stderr = CWD_BEGIN + "\n/home/deploy\n" + CWD_END + "\n"
  eq(extractCwdFromStderr(stderr), { cwd: "/home/deploy", rest: "" }, "cwd is extracted and the probe removed")
}
{
  const stderr = "Warning: Permanently added host\n" + CWD_BEGIN + "\n/root\n" + CWD_END + "\n"
  const r = extractCwdFromStderr(stderr)
  eq(r.cwd, "/root", "cwd is extracted when ssh emitted warnings first")
  eq(r.rest, "Warning: Permanently added host", "unrelated stderr is preserved (not swallowed)")
}
eq(extractCwdFromStderr("no probe here").cwd, null, "missing probe yields null cwd")
eq(extractCwdFromStderr(CWD_BEGIN + "\n\n" + CWD_END).cwd, null, "empty probe yields null cwd")

// ---- stripAnsi: terminal_read must return readable text, not escape soup ----
eq(stripAnsi("\x1b[31mred\x1b[0m"), "red", "SGR colour codes are stripped")
eq(stripAnsi("\x1b[2J\x1b[Hclear"), "clear", "screen-clear and cursor-home are stripped")
eq(stripAnsi("\x1b]0;title\x07text"), "text", "OSC title sequences are stripped")
eq(stripAnsi("plain text"), "plain text", "plain text is untouched")
ok(!stripAnsi("\x1b[1;32mok\x1b[0m").includes("\x1b"), "no escape bytes survive")

// ---- controlPersistValue: "" means "keep the master forever" (the whole point
//      of the plugin — an idle session must not silently drop the password) ----
eq(controlPersistValue({}), "yes", "unset ControlPersist defaults to yes (master never idles out)")
eq(controlPersistValue({ controlPersistSeconds: "" }), "yes", "empty string means yes")
eq(controlPersistValue({ controlPersistSeconds: "   " }), "yes", "whitespace-only means yes")
eq(controlPersistValue({ controlPersistSeconds: "600" }), "600", "a numeric string is passed through")
eq(controlPersistValue({ controlPersistSeconds: 600 }), "600", "a number is stringified")
eq(controlPersistValue({ controlPersistSeconds: "yes" }), "yes", "literal 'yes' is allowed")

// ---- controlPathFor: unix sockets cap near 104 bytes; an over-long path is the
//      classic silent ControlMaster failure, so keep it short and deterministic ----
{
  const a = controlPathFor(parseTarget("root@1.2.3.4"), {})
  const b = controlPathFor(parseTarget("root@1.2.3.4"), {})
  eq(a, b, "same target resolves to the same socket path (connect/exec/close agree)")
  ok(a.length < 104, `socket path stays under the 104-byte limit (${a.length})`)
  const other = controlPathFor(parseTarget("root@5.6.7.8"), {})
  ok(a !== other, "different targets get different sockets")
}
{
  const custom = controlPathFor(parseTarget("root@1.2.3.4"), { controlDir: "/tmp/dsh-test-ctl" })
  ok(custom.startsWith("/tmp/dsh-test-ctl/"), "configured controlDir is honoured")
  ok(custom.endsWith(".sock"), "socket file uses the .sock suffix")
}

// ---- shared state: the host can load this plugin TWICE in one process (its
//      own copy + the plugin manager's installed copy used to verify an
//      update). Each module instance has its own module scope, so plain module
//      constants would give each copy a SEPARATE session map — the browser
//      panel writes its pty into one, the model's tools read the other, and the
//      agent answers "no active terminal" while the user stares at a live
//      terminal. Anchoring on globalThis via Symbol.for fixes that; these
//      assertions pin the fix. ----
{
  const { sessions, terminalRegistry } = __test__
  eq(terminalRegistry, sharedState.terminalRegistry, "terminalRegistry is the process-wide shared map")
  eq(sessions, sharedState.sessions, "sessions is the process-wide shared map")
  eq(typeof sharedState.lastTerminalKey, "object", "lastTerminalKey lives on the shared object (null until a connect)")

  // Symbol.for is the cross-realm registry, so a second module instance — even
  // one loaded from a different URL — resolves the SAME symbol.
  eq(Symbol.for("dsh-ssh-shell.shared"), Symbol.for("dsh-ssh-shell.shared"), "the shared key is a global symbol")
  ok(globalThis[Symbol.for("dsh-ssh-shell.shared")] === sharedState, "the shared state is anchored on globalThis")
}

// ---- bundled skill: installing the plugin must also ship the SKILL.md, or the
//      agent never learns that a panel session exists ----
{
  const p = bundledSkillPath()
  ok(p.endsWith("/skills/ssh-shell/SKILL.md"), `bundled skill path points at skills/ssh-shell/SKILL.md (${p})`)
  ok(existsSync(p), "the bundled SKILL.md exists in this package")
  const body = readFileSync(p, "utf8")
  ok(/^---\n/.test(body), "the bundled SKILL.md starts with YAML frontmatter")
  ok(/\nname:\s*ssh-shell\b/.test(body), "its frontmatter name is ssh-shell")
  ok(/\nwhenToUse:/.test(body), "its frontmatter declares whenToUse")
  ok(body.includes("action=status"), "the skill tells the agent to check status before claiming there is no session")
  ok(body.includes("gui-panel"), "the skill explains the gui-panel source in status output")

  const dir = dshSkillsDir()
  ok(dir.endsWith("/skills/ssh-shell"), `install target is $DSH_HOME/skills/ssh-shell (${dir})`)
}

// ---- installSkill: copies the bundled skill into a DSH_HOME, idempotently, and
//      never throws when the destination is unwritable ----
{
  const tmpHome = mkdtempSync(join(tmpdir(), "dsh-ssh-shell-home-"))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = tmpHome
  const logs = []
  // Mirror the host's REAL logger shape: ctx.logger(name) returns a named logger
  // object with .warn/.info/.error methods. The previous fake was
  // `(level) => (message) => ...`, which encoded a contract the host never had —
  // so the plugin shipped a logger call that threw inside apply() and the host
  // rejected the whole entry ("did not activate").
  const namedLogger = {
    warn: (message) => logs.push(["warn", message]),
    info: (message) => logs.push(["info", message]),
    error: (message) => logs.push(["error", message]),
  }
  const fakeCtx = { logger: () => namedLogger }

  try {
    eq(dshSkillsDir(), join(tmpHome, "skills", "ssh-shell"), "DSH_HOME overrides the install root")

    installSkill(fakeCtx, {})
    const dest = join(tmpHome, "skills", "ssh-shell", "SKILL.md")
    ok(existsSync(dest), "installSkill writes SKILL.md under $DSH_HOME/skills/ssh-shell")
    eq(readFileSync(dest, "utf8"), readFileSync(bundledSkillPath(), "utf8"), "the installed copy matches the bundled one")
    ok(logs.some(([lvl]) => lvl === "info"), "a successful install is logged at info level")

    // Idempotent: an identical copy is left alone (no log, no rewrite).
    const before = logs.length
    installSkill(fakeCtx, {})
    eq(logs.length, before, "a second install with identical content does nothing")

    // The opt-out the test suite itself relies on.
    const other = mkdtempSync(join(tmpdir(), "dsh-ssh-shell-home-"))
    process.env.DSH_HOME = other
    installSkill(fakeCtx, { installSkill: false })
    ok(!existsSync(join(other, "skills", "ssh-shell", "SKILL.md")), "installSkill: false skips the install entirely")
    rmSync(other, { recursive: true, force: true })

    // A failed install is reported, never thrown: the SSH tools must still load.
    process.env.DSH_HOME = join(tmpHome, "a-file-not-a-dir")
    writeFileSync(join(tmpHome, "a-file-not-a-dir"), "x", "utf8")
    let threw = null
    try { installSkill(fakeCtx, {}) } catch (error) { threw = error }
    eq(threw, null, "an unwritable install root does not throw")
    ok(logs.some(([lvl]) => lvl === "warn"), "the failed install is reported as a warning")
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    rmSync(tmpHome, { recursive: true, force: true })
  }
}

process.exit(summary("core_test") ? 0 : 1)
