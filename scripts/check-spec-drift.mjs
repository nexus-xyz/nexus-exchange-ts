#!/usr/bin/env node
/**
 * Spec drift check — keeps `.api-version`, the vendored spec, the targeted
 * schema list, and the hand-written models all in lockstep. Mirrors the Rust
 * SDK's scripts/check_spec_drift.py, adapted to a *vendored* spec.
 *
 * Five independent invariants are enforced (all must hold):
 *
 *   A. .api-version <-> vendored spec version
 *      `.api-version` (validated to look like vX.Y.Z) must equal the vendored
 *      spec's `info.version` (with a `v` prefix). A mismatch means the vendored
 *      spec/openapi.json was updated without bumping the pin, or vice versa.
 *
 *   B. spec/schemas.txt -> spec
 *      Every schema listed in spec/schemas.txt must exist in the spec's
 *      components.schemas. A miss means a renamed/removed/typo'd schema.
 *
 *   C. spec -> spec/schemas.txt
 *      Every schema in the spec must be listed in spec/schemas.txt. A miss is a
 *      coverage gap: a new upstream schema the SDK has not modeled yet. This
 *      fails loudly so new surface can't land unnoticed.
 *
 *   D. spec/schemas.txt -> src/models.ts
 *      Every schema listed in spec/schemas.txt must be exported as a model of
 *      the same name in src/models.ts, so the list can't claim coverage the
 *      code doesn't actually provide.
 *
 *   E. spec enum members <-> src/models.ts (value-level, BOTH ways)
 *      Invariants A–D are name-level only; they never inspect a schema's
 *      contents. E goes one level deeper: for every `enum` in the spec (a
 *      schema-level enum, or a property/array-item `enum`), the matching
 *      hand-written union in src/models.ts must list exactly the same members.
 *        - a spec member missing from models.ts fails (the SDK is behind a new
 *          upstream value — the class of bug behind the PostOnly time-in-force
 *          and WS Liquidations-channel regressions);
 *        - a models.ts member the spec does not list fails too, UNLESS it is
 *          recorded in spec/enum-allowlist.txt as an intentional ahead-of-spec
 *          value. Allowlist entries are themselves checked for staleness: an
 *          entry stops suppressing anything the moment the spec catches up or
 *          the SDK drops the member, and a stale entry fails until removed, so
 *          the allowlist cannot accumulate dead grants.
 *
 * Usage: check-spec-drift.mjs [path-to-openapi.json]
 *   Defaults to the vendored spec/openapi.json. CI also runs it against the
 *   spec freshly fetched from the pinned upstream tag.
 *
 * Pure fs + string parsing: no network, no shell, no eval, no dependencies.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API_VERSION_RE = /^v[0-9]+(\.[0-9]+)*$/;

/** Read a file, exiting with a clear message on any I/O error. */
function read(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    fail(`cannot read ${path}: ${err.message}`);
  }
}

/** Print an error and exit non-zero. */
function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

/** Parse JSON, exiting with a clear message (and the file path) on bad JSON. */
function parseJson(path, text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    fail(`${path} is not valid JSON: ${err.message}`);
  }
}

/** The pinned API version from `.api-version`, validated and trimmed. */
function pinnedVersion() {
  const raw = read(join(REPO, ".api-version")).trim();
  if (!raw) fail(".api-version is empty");
  if (!API_VERSION_RE.test(raw)) {
    fail(`.api-version must look like vX.Y.Z (got: ${JSON.stringify(raw)})`);
  }
  return raw;
}

/** Schema names listed in spec/schemas.txt, with duplicate detection. */
function targetedSchemas() {
  const path = join(REPO, "spec", "schemas.txt");
  const lines = read(path).split("\n");
  const out = [];
  const seen = new Map();
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    if (/\s/.test(line)) {
      fail(
        `spec/schemas.txt:${i + 1}: expected a bare schema name, got ${JSON.stringify(line)}`,
      );
    }
    if (seen.has(line)) {
      fail(
        `spec/schemas.txt:${i + 1}: duplicate schema ${JSON.stringify(line)} (first seen on line ${seen.get(line)})`,
      );
    }
    seen.set(line, i + 1);
    out.push(line);
  });
  if (out.length === 0) fail("spec/schemas.txt lists no schemas");
  return out;
}

/** Names exported from src/models.ts via `export interface X` / `export type X`. */
function exportedModels(src) {
  const out = new Set();
  const re = /export\s+(?:interface|type)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(src)) !== null) out.add(m[1]);
  if (out.size === 0)
    fail(
      "parsed zero exported models from src/models.ts — the export pattern may have changed",
    );
  return out;
}

// ─── Enum-member extraction (invariant E) ────────────────────────────────────
//
// The models file is hand-written TypeScript, not machine output, so this is a
// deliberately small, forgiving parser tuned to the file's conventions rather
// than a full TS parser. It only ever *reads* member sets for the exact fields
// the spec enumerates, so incidental noise elsewhere is harmless.

/** `export type Name = <rhs>;` → Map<name, rhs>. Captures multi-line unions. */
function typeAliases(src) {
  const out = new Map();
  const re =
    /export\s+type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*=\s*([\s\S]*?);/g;
  let m;
  while ((m = re.exec(src)) !== null) out.set(m[1], m[2]);
  return out;
}

/** `export interface Name { ... }` → Map<name, bodyText> via brace matching. */
function interfaceBodies(src) {
  const out = new Map();
  const re = /export\s+interface\s+([A-Za-z_$][\w$]*)[^{]*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    const start = i;
    // {@link ...} braces in JSDoc are self-balanced, so plain counting is safe.
    while (i < src.length && depth > 0) {
      const ch = src[i++];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    out.set(m[1], src.slice(start, i - 1));
    re.lastIndex = i; // skip past the body we just consumed
  }
  return out;
}

/** Field-name → type-expression for one interface body (comments stripped). */
function fieldsOf(body) {
  const src = body
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments (incl. JSDoc)
    .replace(/\/\/[^\n]*/g, " "); // line comments
  const out = new Map();
  // Anchor each field to a declaration boundary so `[key: string]` index
  // signatures and identifiers inside a type don't masquerade as fields.
  const re = /(?:^|[\n{;])\s*([A-Za-z_$][\w$]*)\s*\??\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(src)) !== null)
    if (!out.has(m[1])) out.set(m[1], m[2].trim());
  return out;
}

/**
 * The string-literal members a models.ts type expression resolves to, following
 * named-alias references (e.g. `OrderSide`, or `OpenUnion<OrderType>` → the
 * closed `OrderType` set). Non-string parts (`string`, `null`, generics) add
 * nothing. `seen` guards against cyclic aliases.
 */
function resolveMembers(expr, aliases, seen = new Set()) {
  const members = new Set();
  const litRe = /"([^"]*)"|'([^']*)'/g;
  let m;
  while ((m = litRe.exec(expr)) !== null) members.add(m[1] ?? m[2]);
  const stripped = expr.replace(litRe, " "); // don't treat literal text as an id
  const idRe = /[A-Za-z_$][\w$]*/g;
  let id;
  while ((id = idRe.exec(stripped)) !== null) {
    const name = id[0];
    if (aliases.has(name) && !seen.has(name)) {
      seen.add(name);
      for (const v of resolveMembers(aliases.get(name), aliases, seen))
        members.add(v);
    }
  }
  return members;
}

/**
 * Every `enum` in the spec, as {schema, property|null, locator, members}.
 * Covers schema-level enums, property enums, and array-item enums. Only string
 * members are considered (models.ts models enums as string-literal unions);
 * a numeric-only enum is skipped rather than mis-compared.
 */
function specEnums(spec) {
  const schemas = spec?.components?.schemas ?? {};
  const out = [];
  const strings = (arr) => arr.filter((v) => typeof v === "string");
  const push = (schema, property, arr) => {
    const members = strings(arr);
    if (members.length === 0) return;
    out.push({
      schema,
      property,
      locator: property === null ? schema : `${schema}.${property}`,
      members: new Set(members),
    });
  };
  for (const [schema, def] of Object.entries(schemas)) {
    if (!def || typeof def !== "object") continue;
    if (Array.isArray(def.enum)) push(schema, null, def.enum);
    const props = def.properties;
    if (props && typeof props === "object") {
      for (const [property, pd] of Object.entries(props)) {
        if (!pd || typeof pd !== "object") continue;
        if (Array.isArray(pd.enum)) push(schema, property, pd.enum);
        else if (pd.items && Array.isArray(pd.items.enum))
          push(schema, property, pd.items.enum);
      }
    }
  }
  return out;
}

/**
 * Parse spec/enum-allowlist.txt into [{locator, member, line}]. Absent file =>
 * empty allowlist. Bad syntax / duplicates fail hard, like schemas.txt.
 */
function parseAllowlist() {
  const path = join(REPO, "spec", "enum-allowlist.txt");
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return []; // optional file
    return fail(`cannot read ${path}: ${err.message}`);
  }
  const out = [];
  const seen = new Map();
  const locatorRe = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)?$/;
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const eq = line.indexOf("=");
    if (eq === -1) {
      fail(
        `spec/enum-allowlist.txt:${i + 1}: expected 'Schema.property = member', got ${JSON.stringify(line)}`,
      );
    }
    const locator = line.slice(0, eq).trim();
    const member = line.slice(eq + 1).trim();
    if (!locator || !member) {
      fail(
        `spec/enum-allowlist.txt:${i + 1}: empty locator or member in ${JSON.stringify(line)}`,
      );
    }
    if (!locatorRe.test(locator)) {
      fail(
        `spec/enum-allowlist.txt:${i + 1}: invalid locator ${JSON.stringify(locator)} (want 'Schema' or 'Schema.property')`,
      );
    }
    const key = `${locator} ${member}`;
    if (seen.has(key)) {
      fail(
        `spec/enum-allowlist.txt:${i + 1}: duplicate entry ${JSON.stringify(line)} (first seen on line ${seen.get(key)})`,
      );
    }
    seen.set(key, i + 1);
    out.push({ locator, member, line: i + 1 });
  });
  return out;
}

/**
 * Diff spec enum members against models.ts (invariant E). Returns the delta
 * lists plus the set of allowlist entries that actually did suppression, so the
 * caller can flag the rest as stale.
 */
function enumDrift(spec, modelsSrc, allowlist) {
  const aliases = typeAliases(modelsSrc);
  const interfaces = interfaceBodies(modelsSrc);
  const fieldCache = new Map();
  const fieldsFor = (name) => {
    if (!fieldCache.has(name)) {
      fieldCache.set(
        name,
        interfaces.has(name) ? fieldsOf(interfaces.get(name)) : null,
      );
    }
    return fieldCache.get(name);
  };

  const allowSet = new Set(allowlist.map((a) => `${a.locator} ${a.member}`));
  const usedAllow = new Set();
  const missingInSdk = []; // spec has it, models.ts does not
  const extraInSdk = []; // models.ts has it, spec does not (and not allowlisted)
  const unmodeledField = []; // spec enumerates a field models.ts doesn't provide

  const enums = specEnums(spec);
  for (const e of enums) {
    let sdkMembers = null;
    if (e.property === null) {
      if (aliases.has(e.schema))
        sdkMembers = resolveMembers(aliases.get(e.schema), aliases);
    } else {
      const fields = fieldsFor(e.schema);
      if (fields && fields.has(e.property)) {
        sdkMembers = resolveMembers(fields.get(e.property), aliases);
      }
    }

    if (sdkMembers === null) {
      // Only a finding if the schema is modeled at all; an entirely unmodeled
      // schema is already a coverage gap under invariants C/D.
      if (interfaces.has(e.schema) || aliases.has(e.schema)) {
        unmodeledField.push(
          `${e.locator} (spec enumerates it, but models.ts has no matching ${e.property === null ? "type" : "field"})`,
        );
      }
      continue;
    }

    for (const v of e.members) {
      if (!sdkMembers.has(v))
        missingInSdk.push(`${e.locator}: ${JSON.stringify(v)}`);
    }
    for (const v of sdkMembers) {
      if (e.members.has(v)) continue;
      const key = `${e.locator} ${v}`;
      if (allowSet.has(key)) {
        usedAllow.add(key);
        continue;
      }
      extraInSdk.push(`${e.locator}: ${JSON.stringify(v)}`);
    }
  }

  const staleAllowlist = allowlist
    .filter((a) => !usedAllow.has(`${a.locator} ${a.member}`))
    .map((a) => `${a.locator} = ${a.member} (line ${a.line})`);

  return {
    enumCount: enums.length,
    missingInSdk,
    extraInSdk,
    unmodeledField,
    staleAllowlist,
  };
}

function main() {
  const specPath = process.argv[2]
    ? resolve(process.argv[2])
    : join(REPO, "spec", "openapi.json");

  const pin = pinnedVersion();
  const spec = parseJson(specPath, read(specPath));
  const specVersion = spec?.info?.version;
  if (typeof specVersion !== "string" || !specVersion) {
    fail(`${specPath} has no string info.version`);
  }
  const specSchemas = Object.keys(spec?.components?.schemas ?? {});
  if (specSchemas.length === 0) fail(`${specPath} has no components.schemas`);

  const targeted = targetedSchemas();
  const modelsSrc = read(join(REPO, "src", "models.ts"));
  const models = exportedModels(modelsSrc);
  const allowlist = parseAllowlist();
  const enums = enumDrift(spec, modelsSrc, allowlist);
  const specSet = new Set(specSchemas);
  const targetedSet = new Set(targeted);

  console.log(`Pinned API version : ${pin}`);
  console.log(`Vendored spec      : ${specPath}`);
  console.log(`Spec version       : v${specVersion}`);
  console.log(
    `SDK targets ${targeted.length} schema(s); spec has ${specSchemas.length}.`,
  );
  console.log(
    `Checked ${enums.enumCount} spec enum(s) against models.ts (${allowlist.length} allowlisted member(s)).`,
  );

  let failures = 0;
  const report = (label, items) => {
    if (items.length === 0) return;
    failures += items.length;
    console.error(`\nERROR: ${label}`);
    for (const it of items.sort()) console.error(`  - ${it}`);
  };

  // A. .api-version <-> vendored spec version.
  if (`v${specVersion}` !== pin) {
    failures += 1;
    console.error(
      `\nERROR: version mismatch — .api-version is ${pin} but the spec is v${specVersion}. Bump one to match the other.`,
    );
  }

  // B. schemas.txt -> spec.
  report(
    "schema(s) in spec/schemas.txt are NOT in the spec (removed/renamed/typo):",
    targeted.filter((s) => !specSet.has(s)),
  );

  // C. spec -> schemas.txt (coverage gap).
  report(
    "spec schema(s) NOT covered by spec/schemas.txt (add them + a model, or the SDK is missing surface):",
    specSchemas.filter((s) => !targetedSet.has(s)),
  );

  // D. schemas.txt -> src/models.ts.
  report(
    "schema(s) in spec/schemas.txt have NO matching export in src/models.ts:",
    targeted.filter((s) => !models.has(s)),
  );

  // E. spec enum members <-> src/models.ts (value-level, both ways).
  report(
    "spec enum member(s) NOT modeled in src/models.ts (the SDK is behind the spec — add the value to the matching union):",
    enums.missingInSdk,
  );
  report(
    "enum member(s) in src/models.ts the spec does NOT list (remove them, or record an intentional ahead-of-spec value in spec/enum-allowlist.txt):",
    enums.extraInSdk,
  );
  report(
    "spec enum field(s) with no matching member set in src/models.ts (model the field/type, or the spec dropped an enum the SDK still needs):",
    enums.unmodeledField,
  );
  report(
    "stale spec/enum-allowlist.txt entr(ies) — no longer an ahead-of-spec value (the spec caught up, or the SDK dropped the member); remove them:",
    enums.staleAllowlist,
  );

  if (failures > 0) {
    console.error(`\n${failures} drift error(s).`);
    process.exit(1);
  }
  console.log(
    "\nOK: pin, vendored spec, schemas.txt, models.ts, and enum members are all in sync.",
  );
}

main();
