#!/usr/bin/env node
// Run the whole test suite. No framework, no dependencies — each file is a
// self-contained script that exits non-zero on failure.
//
//   node tests/run_all.mjs
//   npm test

import { spawnSync } from "node:child_process"
import { readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const files = readdirSync(here)
  .filter((f) => f.endsWith("_test.mjs"))
  .sort()

if (files.length === 0) {
  console.error("no tests found")
  process.exit(1)
}

let failed = 0
for (const file of files) {
  console.log(`\n${"=".repeat(64)}\n▶ ${file}\n${"=".repeat(64)}`)
  const r = spawnSync(process.execPath, [join(here, file)], { stdio: "inherit" })
  if (r.status !== 0) failed++
}

console.log(`\n${"=".repeat(64)}`)
if (failed === 0) {
  console.log(`✔ all ${files.length} test files passed`)
} else {
  console.log(`✘ ${failed} of ${files.length} test files failed`)
}
process.exit(failed === 0 ? 0 : 1)
