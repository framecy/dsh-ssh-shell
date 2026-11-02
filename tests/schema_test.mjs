// Regression tests for the schema contract with the host.
//
// 0.7.4 shipped with the plugin's tools silently absent from the model: the
// host's `ctx.tools.register()` rejected `output.schema` because it carried
// `required: true` on properties (the author-facing DSL) instead of
// `required: ["ok", "message"]` on the object (raw JSON Schema). The throw
// landed inside apply(), the host marked the entry "did not activate", and the
// GUI panel kept working — the panel is a webServer route registered before the
// tools, so only the model-facing half died.
//
// These tests drive the REAL apply() against a fake ctx, then check every
// registered definition against the subset the host enforces:
// type/oneOf/properties/required/additionalProperties/items/enum/const plus
// annotations.
//
//   node tests/schema_test.mjs

import { apply, __test__ } from "../lib/index.js"
import { eq, ok, throws, summary } from "./helpers.mjs"

const { compilePropertyMap, compileValueSchema } = __test__

console.log("schema_test: tool schema contract\n")

// ---------------------------------------------------------------------------
// The host's enforced subset, mirrored. Deliberately independent of the
// plugin's own compiler: if the two disagree, the host is the one that throws.
// ---------------------------------------------------------------------------
const SCALARS = new Set(["string", "number", "integer", "boolean", "null"])
const ANNOTATIONS = new Set(["description", "title", "default", "examples"])
const ALLOWED = new Set(["type", "oneOf", "properties", "required", "additionalProperties", "items", "enum", "const", ...ANNOTATIONS])

function violationsOf(schema, path = "schema", out = []) {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    out.push(`${path} must be a schema object`)
    return out
  }
  for (const key of Object.keys(schema)) {
    if (!ALLOWED.has(key)) out.push(`${path}.${key} is not a supported keyword`)
  }
  if (Object.hasOwn(schema, "required")) {
    if (schema.type !== "object") out.push(`${path}.required is not supported on type "${schema.type}"`)
    else if (!Array.isArray(schema.required) || schema.required.some((k) => typeof k !== "string")) {
      out.push(`${path}.required must be an array of strings`)
    } else {
      for (const key of schema.required) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) out.push(`${path}.required names "${key}" which is not in properties`)
      }
    }
  }
  if (Object.hasOwn(schema, "properties")) {
    if (schema.type !== "object") out.push(`${path}.properties is not supported on type "${schema.type}"`)
    else {
      for (const [key, value] of Object.entries(schema.properties)) violationsOf(value, `${path}.properties.${key}`, out)
    }
  }
  if (Object.hasOwn(schema, "additionalProperties")) {
    if (schema.type !== "object") out.push(`${path}.additionalProperties is not supported on type "${schema.type}"`)
    else if (typeof schema.additionalProperties !== "boolean") out.push(`${path}.additionalProperties must be a boolean`)
  }
  if (Object.hasOwn(schema, "items")) {
    if (schema.type !== "array") out.push(`${path}.items is not supported on type "${schema.type}"`)
    else violationsOf(schema.items, `${path}.items`, out)
  }
  if (Object.hasOwn(schema, "enum") && !SCALARS.has(schema.type)) out.push(`${path}.enum requires a scalar type`)
  return out
}

// ---- the compiler itself ----

eq(
  compilePropertyMap({ a: { type: "string", required: true }, b: { type: "boolean" } }, "p"),
  { type: "object", properties: { a: { type: "string" }, b: { type: "boolean" } }, required: ["a"] },
  "required: true on a property becomes the object-level required array",
)
eq(
  compilePropertyMap({ a: { type: "string" } }, "p"),
  { type: "object", properties: { a: { type: "string" } } },
  "no required flag means no required array",
)
eq(
  compileValueSchema({ type: "object", additionalProperties: false, properties: { ok: { type: "boolean", required: true } } }, "s"),
  { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" } }, required: ["ok"] },
  "output schemas compile the same way",
)
eq(
  compileValueSchema({ type: "string", description: "d", enum: ["a", "b"] }, "s"),
  { description: "d", type: "string", enum: ["a", "b"] },
  "scalar annotations, enum survive compilation",
)
throws(() => compileValueSchema({ type: "wat" }, "s"), "an unknown type is rejected at compile time, not at registration")
throws(() => compilePropertyMap({ a: { type: "string", required: "yes" } }, "p"), "a non-boolean required is rejected")

// The exact shape 0.7.4 shipped — proof the mirror catches it.
ok(
  violationsOf({ type: "object", additionalProperties: false, properties: { ok: { type: "boolean", required: true } } }).length > 0,
  "the 0.7.4 output schema (boolean required on a property) violates the host subset",
)

// ---- the real definitions, as apply() registers them ----

const registered = {}
const ctx = {
  logger: () => ({ warn: () => {}, info: () => {}, error: () => {}, debug: () => {}, verbose: () => {} }),
  webServer: { registerUpgrade: () => {} },
  systemPrompt: { section: () => {} },
  tools: { register: (definition) => { registered[definition.name] = definition } },
  get: () => undefined,
}

apply(ctx, { installSkill: false })

eq(
  Object.keys(registered).sort(),
  ["ssh_remote", "ssh_terminal_read", "ssh_terminal_send"],
  "apply() registers all three tools",
)

for (const [name, definition] of Object.entries(registered)) {
  eq(violationsOf(definition.parameters, `${name}.parameters`), [], `${name}.parameters is a schema the host accepts`)
  eq(violationsOf(definition.output.schema, `${name}.output.schema`), [], `${name}.output.schema is a schema the host accepts`)
  ok(typeof definition.output.render === "function", `${name} keeps its output renderer`)
  ok(typeof definition.execute === "function", `${name} keeps its execute`)
}

eq(registered.ssh_remote.parameters.required, ["action"], "ssh_remote declares action as the only required argument")
eq(registered.ssh_remote.parameters.properties.action.enum, ["connect", "exec", "close", "status"], "ssh_remote keeps the action enum")
eq(registered.ssh_remote.output.schema.required, ["ok", "message"], "ssh_remote output requires ok + message")
ok(
  Object.hasOwn(registered.ssh_remote.parameters.properties, "password"),
  "ssh_remote still exposes the password argument",
)

// ---- a rejected tool must not take the plugin down ----

const survivors = {}
const rejectingCtx = {
  ...ctx,
  tools: {
    register: (definition) => {
      if (definition.name === "ssh_terminal_read") throw new Error("JsonSchemaError: unsupported JSON schema: nope")
      survivors[definition.name] = definition
    },
  },
}
apply(rejectingCtx, { installSkill: false })
eq(
  Object.keys(survivors).sort(),
  ["ssh_remote", "ssh_terminal_send"],
  "one host-rejected tool does not abort the other registrations",
)

process.exit(summary("schema_test") ? 0 : 1)
