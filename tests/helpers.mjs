// Test harness: run the plugin's real code against FAKE ssh / sshpass / pty.
//
// Why fakes: the test machine has no reachable sshd, and we do not want CI to
// need one. We intercept at the process boundary instead — `spawn` /
// `spawnSync` for ssh+sshpass, and `node-pty` for the interactive terminal —
// so the plugin's own parsing, session bookkeeping, keepalive and rescue logic
// all run for real.
//
// Usage:  import { makeFakeSsh } from "./helpers.mjs"
//
// The fake ssh is driven by a scenario: each invocation gets a decided exit
// code, stdout and stderr, so a test can simulate "master alive", "master
// dead", "command failed", "pty crashed", etc.

import { EventEmitter } from "node:events"

/** Build a scripted process stub that looks like a child_process result. */
export function fakeChild({ stdout = "", stderr = "", code = 0, delayMs = 0 } = {}) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.pid = 4242
  child.killed = false
  child.kill = () => {
    child.killed = true
    child.emit("close", null, "SIGTERM")
    return true
  }
  setTimeout(() => {
    if (child.killed) return
    if (stdout) child.stdout.emit("data", Buffer.from(stdout))
    if (stderr) child.stderr.emit("data", Buffer.from(stderr))
    child.emit("close", code, null)
  }, delayMs)
  return child
}

/** A bare Promise wrapper for assertions on async behaviour. */
export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Assertion helpers. Deliberately tiny: no dependency, no config, and the
 * failure message names what was expected so a red run is self-explanatory.
 */
let passed = 0
let failed = 0
const failures = []

export function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    passed++
    console.log(`  ok   ${label}`)
  } else {
    failed++
    failures.push(label)
    console.log(`  FAIL ${label}\n         expected: ${e}\n         actual:   ${a}`)
  }
}

export function ok(value, label) {
  eq(Boolean(value), true, label)
}

export function throws(fn, label) {
  let threw = false
  try {
    fn()
  } catch {
    threw = true
  }
  eq(threw, true, label)
}

export function summary(name) {
  console.log(`\n${name}: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log("failed cases:")
    for (const f of failures) console.log(`  - ${f}`)
  }
  return failed === 0
}
