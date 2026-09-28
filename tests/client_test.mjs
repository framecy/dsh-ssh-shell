// Client-bundle tests: the browser half must LOAD cleanly, and its window
// geometry maths must keep the floating panel reachable.
//
// Two things are worth guarding here:
//   1. Loadability. client.js is not a module — it hands a factory to
//      window.__ModuleLoader__, which passes ONLY `require`. A missing CJS
//      shim (module/exports) makes the whole plugin list fail to load, which
//      surfaces to the user as "Failed to load plugins" and no terminal button
//      at all. That regression already happened once.
//   2. clampGeom. Drag-to-move, drag-to-resize, sessionStorage restore and
//      viewport shrink all funnel through it; an off-by-one there strands the
//      panel off-screen with no way to grab it back.
//
// The store is private to the bundle, so geometry is read through the same
// path the UI uses: render the registered overlay slot and let the component
// hand its snapshot to our useSyncExternalStore stub.
//
//   node tests/client_test.mjs

import { readFileSync } from "node:fs"
import { eq, ok, summary } from "./helpers.mjs"

console.log("client_test: browser bundle\n")

const GEOM_KEY = "dsh-ssh-shell.geom"
const MIN_W = 340
const MIN_H = 240
const KEEP_X = 120
const KEEP_Y = 48

// ---------------------------------------------------------------------------
// Minimal browser environment. React is faked just far enough to run the
// bundle and to capture what the components read from the store.
// ---------------------------------------------------------------------------
const storage = new Map()
const fakeStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
}

/** What the components read from the store during a render pass. */
const observed = { geometry: null, visible: null, snapshots: [] }

const reactStub = {
  createElement: (...args) => ({ __el: true, args }),
  Fragment: Symbol("Fragment"),
  useState: (init) => [typeof init === "function" ? init() : init, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
  useSyncExternalStore: (subscribe, getSnapshot) => {
    const value = getSnapshot()
    observed.snapshots.push(value)
    if (value && typeof value === "object" && "w" in value) observed.geometry = value
    else observed.visible = value
    return value
  },
}

const slots = []
let handedOff = null

globalThis.window = {
  innerWidth: 1440,
  innerHeight: 900,
  sessionStorage: fakeStorage,
  addEventListener: () => {},
  removeEventListener: () => {},
  __ModuleLoader__: { load: (h) => (handedOff = h) },
}
globalThis.document = {
  addEventListener: () => {},
  removeEventListener: () => {},
  createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
  head: { appendChild: () => {} },
  body: { appendChild: () => {} },
}
globalThis.location = { protocol: "http:", host: "127.0.0.1:3080" }

const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8")

/**
 * Evaluate the bundle fresh (new closure, new store) with the given viewport
 * and stored geometry, then run apply() and read the store the bundle exports
 * for exactly this purpose (`exports.__terminalStore`).
 */
function loadAndRender({ innerWidth = 1440, innerHeight = 900, stored = null, rawStored = null } = {}) {
  storage.clear()
  if (rawStored != null) storage.set(GEOM_KEY, rawStored)
  else if (stored) storage.set(GEOM_KEY, JSON.stringify(stored))

  globalThis.window.innerWidth = innerWidth
  globalThis.window.innerHeight = innerHeight
  slots.length = 0
  observed.geometry = null
  observed.visible = null
  observed.snapshots.length = 0

  const fn = new Function("window", "document", "location", "React", "require", source)
  fn(globalThis.window, globalThis.document, globalThis.location, reactStub, (id) =>
    id === "react" ? reactStub : {},
  )

  // Drive the real plugin entry: apply(ctx) registers the slots.
  const exportsObj = handedOff.factory((id) => (id === "react" ? reactStub : {}))
  const ctx = {
    slots: {
      inject: (name, cb) => cb(),
      register: (def, component) => {
        slots.push({ ...def, component })
        return def
      },
    },
  }
  exportsObj.apply(ctx)

  // The bundle exposes its store for exactly this kind of inspection.
  const store = exportsObj.__terminalStore
  const geometry = store ? store.getGeometry() : null
  return { slots: slots.slice(), geometry, store, exports: exportsObj }
}

// ---------------------------------------------------------------------------
// 1. Loadability + the CJS-shim contract.
// ---------------------------------------------------------------------------
{
  let loadError = null
  try {
    const fn = new Function("window", "document", "location", "React", "require", source)
    fn(globalThis.window, globalThis.document, globalThis.location, reactStub, (id) =>
      id === "react" ? reactStub : {},
    )
  } catch (err) {
    loadError = err
  }
  eq(loadError, null, "client.js evaluates without throwing")
  ok(handedOff, "client.js hands a module to window.__ModuleLoader__")
  eq(handedOff && handedOff.id, "dsh-ssh-shell", "the module is registered under the plugin id")

  let factoryError = null
  let exportsObj = null
  try {
    // dsh-loader calls the factory with ONLY `require` — no exports/module.
    exportsObj = handedOff.factory((id) => (id === "react" ? reactStub : {}))
  } catch (err) {
    factoryError = err
  }
  eq(factoryError, null, "factory(require) runs without ReferenceError (CJS shim present)")
  eq(typeof exportsObj.apply, "function", "client bundle exports apply()")
}

// ---------------------------------------------------------------------------
// 2. Slot registration: both slots the README promises must be registered,
//    each with its component as the second argument to register().
// ---------------------------------------------------------------------------
{
  const { slots: registered } = loadAndRender({})
  const byName = Object.fromEntries(registered.map((s) => [s.name, s]))
  ok(byName["conversation.session.header.actions"], "registers the header-actions toggle slot")
  ok(byName["shell.overlay"], "registers the floating overlay slot")
  eq(typeof byName["conversation.session.header.actions"].component, "function", "the header slot carries a component")
  eq(typeof byName["shell.overlay"].component, "function", "the overlay slot carries a component")
  eq(byName["shell.overlay"].id, "ssh-terminal-panel", "the overlay slot has a stable id")
}

// ---------------------------------------------------------------------------
// 2b. Store contract: the panel's visible flag is separate from the socket, so
//     hiding the panel must not disturb geometry (hiding is display:none only).
// ---------------------------------------------------------------------------
{
  const { store } = loadAndRender({})
  const seen = []
  const unsubscribe = store.subscribe(() => seen.push(store.getVisible()))

  eq(store.getVisible(), false, "the panel starts hidden")
  store.toggle()
  eq(store.getVisible(), true, "toggle() shows the panel")
  store.toggle()
  eq(store.getVisible(), false, "toggle() hides the panel again")
  eq(seen.length, 2, "subscribers are notified once per visibility change")

  store.setVisible(false)
  eq(seen.length, 2, "setting the same visibility does not re-notify (no render churn)")

  unsubscribe()
  store.toggle()
  eq(seen.length, 2, "unsubscribe stops notifications")

  // Snapshot identity must be stable between changes: React's
  // useSyncExternalStore loops forever on a fresh object every call.
  const snap1 = store.getGeometry()
  const snap2 = store.getGeometry()
  ok(snap1 === snap2, "getGeometry returns a stable snapshot between changes")
}

// ---------------------------------------------------------------------------
// 2c. setGeometry clamps and persists; invalid input is ignored.
// ---------------------------------------------------------------------------
{
  const { store } = loadAndRender({})
  store.setGeometry({ x: 120, y: 90, w: 620, h: 480 })
  eq(store.getGeometry(), { x: 120, y: 90, w: 620, h: 480 }, "an in-range geometry is applied")
  eq(JSON.parse(storage.get(GEOM_KEY)), { x: 120, y: 90, w: 620, h: 480 }, "applied geometry is persisted for a refresh")

  const before = store.getGeometry()
  store.setGeometry({ w: 10, h: 10 })
  const after = store.getGeometry()
  ok(after.w >= MIN_W && after.h >= MIN_H, "setGeometry clamps a too-small size to the minimum")
  ok(before !== after, "a clamped change still produces a new snapshot")

  store.resetGeometry()
  eq(store.getGeometry().w, 660, "resetGeometry restores the default size")
}

// ---------------------------------------------------------------------------
// 3. clampGeom, observed through the real render path.
// ---------------------------------------------------------------------------
// In-range geometry is restored verbatim (position survives a refresh).
{
  const { geometry } = loadAndRender({ stored: { x: 300, y: 200, w: 700, h: 500 } })
  ok(geometry, "rendering the overlay yields a geometry snapshot")
  eq({ x: geometry.x, y: geometry.y, w: geometry.w, h: geometry.h }, { x: 300, y: 200, w: 700, h: 500 }, "in-range geometry is restored verbatim")
}

// Absurd stored values are clamped to something the user can still grab.
{
  const { geometry } = loadAndRender({ stored: { x: 99999, y: 99999, w: 10, h: 10 } })
  ok(geometry.w >= MIN_W, `restored width is floored at the ${MIN_W}px minimum (got ${geometry.w})`)
  ok(geometry.h >= MIN_H, `restored height is floored at the ${MIN_H}px minimum (got ${geometry.h})`)
  ok(geometry.x <= 1440 - KEEP_X, `restored x keeps ${KEEP_X}px of title bar on screen (got ${geometry.x})`)
  ok(geometry.y <= 900 - KEEP_Y, `restored y keeps ${KEEP_Y}px of title bar on screen (got ${geometry.y})`)
}

// Far-negative positions still leave a grab handle visible.
{
  const { geometry } = loadAndRender({ stored: { x: -99999, y: -99999, w: 660, h: 640 } })
  ok(geometry.x >= -(660 - KEEP_X), `a far-left panel keeps ${KEEP_X}px on screen (got ${geometry.x})`)
  ok(geometry.y >= -(640 - KEEP_Y), `a far-up panel keeps ${KEEP_Y}px on screen (got ${geometry.y})`)
}

// A viewport smaller than the minimum still yields a usable panel.
{
  const { geometry } = loadAndRender({ innerWidth: 320, innerHeight: 200, stored: { x: 10, y: 10, w: 700, h: 700 } })
  ok(geometry.w >= MIN_W && geometry.h >= MIN_H, "panel keeps its minimum size even in a tiny viewport")
}

// Oversized geometry is capped to the viewport.
{
  const { geometry } = loadAndRender({ stored: { x: 0, y: 0, w: 99999, h: 99999 } })
  ok(geometry.w <= 1440 - 16, `width is capped to the viewport (got ${geometry.w})`)
  ok(geometry.h <= 900 - 16, `height is capped to the viewport (got ${geometry.h})`)
}

// Corrupt sessionStorage must not break the load (falls back to defaults).
{
  const { geometry } = loadAndRender({ rawStored: "{not json" })
  ok(geometry, "corrupt stored geometry still yields a usable panel")
  ok(geometry.w >= MIN_W && geometry.h >= MIN_H, "corrupt stored geometry falls back to a valid default")
}

// Geometry values are whole numbers (no fractional drift from dragging).
{
  const { geometry } = loadAndRender({ stored: { x: 100.7, y: 50.2, w: 660.9, h: 640.4 } })
  for (const [k, v] of Object.entries(geometry)) {
    eq(Number.isInteger(v), true, `geometry.${k} is an integer (drag does not accumulate fractions)`)
  }
}

process.exit(summary("client_test") ? 0 : 1)
