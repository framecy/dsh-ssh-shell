#!/usr/bin/env node
// Link the DSH host's own @deepseek-ai packages into this checkout so `npm test`
// can import them — WITHOUT declaring them as dependencies.
//
// Why not devDependencies: DSH profiles install plugins with pnpm and
// `autoInstallPeers: false`. Declaring @deepseek-ai/dsh-tools as a devDependency
// makes pnpm resolve it (and its whole peer chain) into the profile's dependency
// tree, which changes how the *installed* plugin resolves at runtime. 0.7.0 did
// exactly that and the plugin stopped loading entirely (ESM link-stage
// MODULE_NOT_FOUND on dsh-tools → apply() never ran → no tools, no route).
// @deepseek-ai/dsh-tools is an internal prerelease package owned by the host;
// a second copy also splits the tool registry. Link, never install.
//
// Usage:  node scripts/link-host-deps.mjs [--host <dsh dir>]

import { existsSync, mkdirSync, symlinkSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..")

const CANDIDATES = [
  process.env.DSH_HOST_DIR,
  "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar.unpacked/dsh",
  join(process.env.HOME ?? "", ".dsh", "profiles", "node_modules", "@deepseek-ai", "dsh"),
]

const host = process.argv.includes("--host")
  ? process.argv[process.argv.indexOf("--host") + 1]
  : CANDIDATES.find((dir) => dir && existsSync(join(dir, "node_modules", "@deepseek-ai", "dsh-tools")))

if (!host) {
  console.error(
    "link-host-deps: could not find the DSH host's node_modules.\n" +
      "Pass --host <path-to-dsh-dir> (the directory that contains node_modules/@deepseek-ai/dsh-tools).",
  )
  process.exit(1)
}

const hostModules = join(host, "node_modules")
const wanted = ["@deepseek-ai/dsh-tools"]
let linked = 0

for (const spec of wanted) {
  const from = join(hostModules, spec)
  if (!existsSync(from)) {
    console.error(`link-host-deps: ${from} does not exist; skipping`)
    continue
  }
  const to = join(root, "node_modules", spec)
  mkdirSync(dirname(to), { recursive: true })
  rmSync(to, { recursive: true, force: true })
  symlinkSync(from, to, "dir")
  console.log(`linked ${spec} -> ${from}`)
  linked++
}

// dsh-tools imports these at module scope; link its own deps too when the host
// layout keeps them outside its directory.
for (const extra of ["@deepseek-ai/cosmokit", "@deepseek-ai/schemastery"]) {
  const from = join(hostModules, extra)
  if (!existsSync(from)) continue
  const to = join(root, "node_modules", extra)
  mkdirSync(dirname(to), { recursive: true })
  rmSync(to, { recursive: true, force: true })
  symlinkSync(from, to, "dir")
  console.log(`linked ${extra} -> ${from}`)
  linked++
}

if (linked === 0) process.exit(1)
console.log(`\ndone — ${linked} link(s). Run: npm test`)
