#!/usr/bin/env node
/**
 * Spec drift check — keeps `.api-version`, the vendored spec, the targeted
 * schema list, the operations manifest, and the hand-written client/models all
 * in lockstep. Mirrors the Rust SDK's scripts/check_spec_drift.py, adapted to a
 * *vendored* spec.
 *
 * Eight independent invariants are enforced (all must hold). A–E are
 * schema-level; F–H are the operations half (ENG-7963), mirroring B/C/D for the
 * REST surface the client actually implements:
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
 *   F. endpoints.txt -> spec                          (the operations analogue of B)
 *      Every operation the SDK targets (endpoints.txt) must exist in the spec.
 *      A miss means a removed/renamed/typo'd operation — including the
 *      path-prefix class of typo that left nexus-exchange-py's manifest listing
 *      six operations no released spec has ever contained (ENG-7958).
 *
 *   G. spec -> endpoints.txt U spec/uncovered-ops.txt  (the operations analogue of C)
 *      Every operation in the spec must be either targeted (endpoints.txt) or
 *      recorded as deliberately not targeted (spec/uncovered-ops.txt). Unlike
 *      the schema list, 100% operation coverage is not a goal — the spec carries
 *      admin routes, deprecated routes, and legacy-gateway twins of operations
 *      the SDK reaches through `/api/v1`. What G buys is C's real property: new
 *      upstream surface cannot land unnoticed. Entries in uncovered-ops.txt are
 *      checked for staleness both ways (gone from the spec, or now targeted), so
 *      that file cannot rot into a list of things that no longer exist.
 *
 *   H. src/client.ts <-> endpoints.txt                (the operations analogue of D)
 *      The manifest must not claim coverage the code lacks, nor miss coverage
 *      the code has. The REST operations the client actually implements are
 *      derived from the `this.#request(METHOD, path, opts)` call sites in
 *      src/client.ts and must EQUAL the endpoints.txt set, modulo ONE named
 *      allowlist:
 *        - NON_REST_TARGETS — targeted without a REST helper call, so invisible
 *          to the code parser (`GET /ws`, opened by src/ws/client.ts). Carries
 *          the staleness checks the enum allowlist has: an entry the code turns
 *          out to implement, or one endpoints.txt does not list, fails until it
 *          is removed.
 *      There is deliberately NO allowlist for the other direction. An operation
 *      the pinned spec does not define must not be implemented at all, so
 *      "implemented but not in endpoints.txt" is always a finding — see
 *      CODE_ONLY_OPS below, which exists only to fail on any entry.
 *
 * Usage: check-spec-drift.mjs [path-to-openapi.json]
 *   Defaults to the vendored spec/openapi.json. CI also runs it against the
 *   spec freshly fetched from the pinned upstream tag.
 *
 * Pure fs + string parsing: no network, no shell, no eval, no dependencies.
 *
 * Every invariant here has a test in test/models.test.ts that defeats it in a
 * throwaway copy of the repo's drift inputs and asserts the gate goes red — a
 * green run from a checker nothing has ever proven can fail is worth very
 * little. Add one alongside any invariant you add.
 */
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

// ─── Operations invariants F/G/H (ENG-7963) ──────────────────────────────────
//
// The schema invariants above never look at the *routes* the SDK calls, so for
// a long time nothing in CI noticed a wrapper being added, removed, or pointed
// at a path no released spec contains. These three close that gap. The unit of
// comparison is an operation string, `"METHOD /path"`, with every `{...}` path
// placeholder collapsed to `{}` when comparing against code (the client builds
// paths from template holes, so placeholder *names* exist only in the spec and
// the manifest — matching is by position).

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/**
 * Operations `src/client.ts` implements that the pinned spec does not define.
 *
 * **Empty by policy, and enforced empty** (ENG-8616 / ENG-8620): an endpoint
 * that is not in the spec must not be implemented. Any entry here is a finding
 * — there is no attribution, no parking, and no release-lag exception. An SDK
 * that wants an operation waits for the published tag that defines it, then
 * implements it against that tag and lists it in endpoints.txt like any other.
 *
 * ## Why an empty Set rather than no Set
 *
 * This constant is the seam a future copy of this checker would reach for. It
 * is kept, empty, so that reaching for it fails loudly with the reason attached
 * (invariant H) instead of silently reintroducing the opt-out. Deleting it
 * would leave "implemented but not in endpoints.txt" as the only guard — the
 * same guard whose escape hatch this used to be.
 *
 * ## What it used to hold, and how those entries were resolved
 *
 * Six ops, all sent under `/api/v1` while the spec declared only the bare form:
 * `{GET,POST} /deposits`, `GET /withdrawals`, `POST /faucet`,
 * `POST /account/deposit` and `POST /account/margin`. Four were parked as
 * "ahead of the spec" (the server does mount `/api/v1` siblings for them,
 * `funds_extra_v1_routes` / ENG-4737) and two as a measured 404 (ENG-8463).
 * Neither reading survives the policy: a route the contract does not document
 * is not a route this SDK may target, and "the spec will catch up" had not
 * happened in any release since the entries were written. All six now send the
 * path the spec declares, `root: true`, and are listed in endpoints.txt.
 *
 * The rot checks this list used to carry only ever fired on a CHANGE — the op
 * stopped being implemented, or the spec caught up. An op that has never been
 * in any spec version, and never will be, satisfies neither and sits green
 * forever. That hole is what "fail on any entry" closes.
 */
const CODE_ONLY_OPS = new Set([]);

/**
 * Operations listed in endpoints.txt that are reached WITHOUT a
 * `this.#request(...)` call, so the code parser cannot (and should not) see
 * them. `GET /ws` is the WebSocket upgrade: src/ws/client.ts opens it against
 * the caller-supplied `url` + `path` (default `/ws`) with a `WebSocket`
 * constructor, never a REST helper.
 */
const NON_REST_TARGETS = new Set(["GET /ws"]);

/** Collapse every `{placeholder}` to a bare `{}` so matching is positional. */
function normalizeOpPath(path) {
  return path.replace(/\{[^}]*\}/g, "{}");
}

/** The `METHOD /path` operations the spec defines, as a Set of strings. */
function specOperations(spec) {
  const out = new Set();
  for (const [path, methods] of Object.entries(spec?.paths ?? {})) {
    if (!methods || typeof methods !== "object") continue;
    for (const method of Object.keys(methods)) {
      const upper = method.toUpperCase();
      if (HTTP_METHODS.has(upper)) out.add(`${upper} ${path}`);
    }
  }
  if (out.size === 0) fail("the spec defines no operations under `paths`");
  return out;
}

/**
 * Parse a `METHOD /path`-per-line manifest (endpoints.txt, uncovered-ops.txt)
 * into [{op, line}]. Blank lines and `#` comments are skipped; a malformed line,
 * an unknown method, or a duplicate fails hard, exactly like spec/schemas.txt.
 */
function parseOpsManifest(label, text) {
  const out = [];
  const seen = new Map();
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const parts = line.split(/\s+/);
    if (parts.length !== 2) {
      fail(
        `${label}:${i + 1}: expected 'METHOD /path', got ${JSON.stringify(line)}`,
      );
    }
    const [method, path] = parts;
    if (!HTTP_METHODS.has(method)) {
      fail(
        `${label}:${i + 1}: unknown HTTP method ${JSON.stringify(method)} (want one of ${[...HTTP_METHODS].join(", ")}, uppercase)`,
      );
    }
    if (!path.startsWith("/")) {
      fail(
        `${label}:${i + 1}: path must start with '/', got ${JSON.stringify(path)}`,
      );
    }
    const op = `${method} ${path}`;
    if (seen.has(op)) {
      fail(
        `${label}:${i + 1}: duplicate operation ${JSON.stringify(op)} (first seen on line ${seen.get(op)})`,
      );
    }
    seen.set(op, i + 1);
    out.push({ op, line: i + 1 });
  });
  return out;
}

/**
 * The base path every non-`root` request is sent under, read out of
 * `API_BASE_PATH` in src/client.ts rather than hardcoded here — the prefix is
 * what turns a method-relative path into the spec path, so a checker that
 * hardcoded it would go on comparing the old paths after a base-URL change and
 * report green over every one of them.
 *
 * Reads the one exported constant rather than reconciling the per-network base
 * URLs (ENG-6453). Agreement across that table used to be the invariant, and it
 * is no longer the right one: the networks deliberately do NOT all share a
 * prefix now — mainnet's durable base is `/v1`-shaped and has no live host at
 * all — so requiring agreement would fail on a correct map. `API_BASE_PATH` is
 * what every non-root request actually composes, in one place, and every live
 * network base is built from it (pinned by a unit test in test/client.test.ts).
 */
function clientBasePath(src) {
  const found = /export\s+const\s+API_BASE_PATH\s*=\s*"([^"]*)"/.exec(src);
  if (!found) {
    fail(
      'could not find `export const API_BASE_PATH = "…"` in src/client.ts; the base-path constant moved or changed shape — update clientBasePath()',
    );
  }
  const base = found[1];
  if (!base) {
    fail(
      "`API_BASE_PATH` in src/client.ts is empty; if the SDK moved to host-root requests, drop the prefixing in implementedOps()",
    );
  }
  // It is concatenated straight onto method-relative paths, so a stray leading
  // or trailing slash would silently shift every derived operation.
  if (!base.startsWith("/") || base.endsWith("/")) {
    fail(
      `\`API_BASE_PATH\` must start with "/" and must not end with one (got ${JSON.stringify(base)}); it is concatenated directly onto method-relative paths`,
    );
  }
  return base;
}

// Every REST call in src/client.ts goes through the single private helper
// `this.#request(method, path, options?)`, so — unlike the Rust SDK's several
// typed helpers — there is exactly one call shape to parse. The parser depends
// on two conventions at those call sites, and ENFORCES both with a loud failure
// rather than best-effort guessing, because the failure mode that matters is
// *undercounting* (a checker reporting green over a real gap is worse than no
// checker):
//
//   1. the method and path are inline literals — `"GET"` and either `"/orders"`
//      or a template literal `` `/orders/${seg(id)}` `` — never built into a
//      local variable first;
//   2. the options argument, when present, is either an inline object literal
//      or a bare identifier forwarded from the method's own `opts` parameter.
//      `root: true` (which drops the `/api/v1` prefix) is only ever set in an
//      inline literal, so an expression the parser cannot see through would
//      silently attribute the call to the wrong path.
const REQUEST_CALL = "this.#request";

/**
 * Split a balanced argument list starting at `src[open]` (which must be the
 * `(`), returning `{ args, end }` with top-level comma-separated argument text.
 * Tracks nesting for `()[]{}` and skips string / template literals so a comma,
 * brace, or paren inside one cannot end an argument early.
 */
function splitArgs(src, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      // Skip the literal. Template literals may nest `${ … }` holes containing
      // further literals, so track the hole depth while scanning.
      const quote = ch;
      i++;
      let holes = 0;
      for (; i < src.length; i++) {
        if (src[i] === "\\") {
          i++;
          continue;
        }
        if (quote === "`" && src[i] === "$" && src[i + 1] === "{") {
          holes++;
          i++;
          continue;
        }
        if (holes > 0 && src[i] === "}") {
          holes--;
          continue;
        }
        if (holes === 0 && src[i] === quote) break;
      }
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        const tail = src.slice(start, i).trim();
        if (tail) args.push(tail);
        return { args, end: i };
      }
      continue;
    }
    if (ch === "," && depth === 1) {
      args.push(src.slice(start, i).trim());
      start = i + 1;
    }
  }
  fail(
    `unterminated \`${REQUEST_CALL}(\` argument list in src/client.ts (starting at offset ${open})`,
  );
}

/** The value of a plain `"..."` / `'...'` string literal, or null. */
function stringLiteral(expr) {
  const m = /^"([^"\\]*)"$|^'([^'\\]*)'$/.exec(expr);
  return m ? (m[1] ?? m[2]) : null;
}

/**
 * The path a literal path argument resolves to, with template holes collapsed
 * to `{}`; null when the argument is not an inline literal at all.
 */
function literalPath(expr) {
  const plain = stringLiteral(expr);
  if (plain !== null) return plain;
  if (expr.startsWith("`") && expr.endsWith("`")) {
    return expr.slice(1, -1).replace(/\$\{[^}]*\}/g, "{}");
  }
  return null;
}

/**
 * Derive the `METHOD /full-path` operations src/client.ts implements from its
 * `this.#request(...)` call sites, prefixing `basePath` unless the call opts out
 * with `root: true`. Placeholders are normalized to `{}`.
 */
function implementedOps(src, basePath = clientBasePath(src)) {
  const ops = new Set();
  let searched = 0;
  let count = 0;
  for (;;) {
    const at = src.indexOf(REQUEST_CALL, searched);
    if (at === -1) break;
    searched = at + REQUEST_CALL.length;

    // Skip past an optional type argument (`<Record<string, Ticker>>`) to reach
    // the `(` that opens the call. Angle brackets nest; anything else between
    // the callee and the paren means this is not a call site (e.g. prose in a
    // comment), so it is skipped rather than guessed at.
    let i = searched;
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] === "<") {
      let angles = 0;
      for (; i < src.length; i++) {
        if (src[i] === "<") angles++;
        else if (src[i] === ">" && --angles === 0) {
          i++;
          break;
        }
      }
      while (i < src.length && /\s/.test(src[i])) i++;
    }
    if (src[i] !== "(") continue;

    const line = src.slice(0, at).split("\n").length;
    const { args, end } = splitArgs(src, i);
    searched = end;
    count++;

    const method = stringLiteral(args[0] ?? "");
    if (method === null || !HTTP_METHODS.has(method)) {
      fail(
        `src/client.ts:${line}: \`${REQUEST_CALL}\` must take an inline uppercase method literal as its first argument (got ${JSON.stringify(args[0] ?? "")}); the drift parser reads it to derive the implemented operation set`,
      );
    }
    const path = literalPath(args[1] ?? "");
    if (path === null || !path.startsWith("/")) {
      fail(
        `src/client.ts:${line}: \`${REQUEST_CALL}\` must take an inline path literal ("/orders" or \`/orders/\${…}\`) as its second argument (got ${JSON.stringify(args[1] ?? "")}); a path built into a local variable first would be invisible here and silently undercount the implemented set`,
      );
    }

    const opts = args[2];
    let root = false;
    if (opts !== undefined) {
      if (opts.startsWith("{")) {
        root = /\broot\s*:\s*true\b/.test(opts);
      } else if (!/^[A-Za-z_$][\w$]*$/.test(opts)) {
        fail(
          `src/client.ts:${line}: the options argument to \`${REQUEST_CALL}\` must be an inline object literal or a bare identifier (got ${JSON.stringify(opts)}); \`root: true\` decides whether the call targets ${JSON.stringify(basePath)} or the host root, so an expression the parser cannot see through would attribute the call to the wrong path`,
        );
      }
    }

    ops.add(`${method} ${normalizeOpPath(root ? path : basePath + path)}`);
  }

  if (count === 0) {
    fail(
      `parsed zero \`${REQUEST_CALL}(\` call sites from src/client.ts — the request helper was renamed or restructured; update implementedOps()`,
    );
  }
  return ops;
}

/**
 * One `"METHOD /path"` per operation, whichever spelling the spec used.
 *
 * Exported so the self-test can assert the resulting op IDENTITY, not just the
 * counts derived from it. That distinction is not academic: stripping the prefix
 * without requiring the trailing slash turns `/api/v1foo` into `foo` — an
 * operation the spec never declared — and every count in the summary comes out
 * the same, so a count-only test passes over it (ENG-11847).
 *
 * `basePath` is `API_BASE_PATH` from src/client.ts. An empty prefix
 * canonicalizes nothing, which degrades to the old per-path counting rather than
 * mangling anything.
 */
function canonicalOp(op, basePath) {
  const prefix = (basePath || "").replace(/\/$/, "");
  const [method, path] = op.split(" ");
  const bare =
    prefix && path.startsWith(prefix + "/") ? path.slice(prefix.length) : path;
  return `${method} ${bare}`;
}

/**
 * Invariants F/G/H. Returns `{ findings, summary }`: `findings` is a list of
 * `{ label, items }` groups for main() to report and count, `summary` a line
 * for the run header. Pure — every input is passed in, so the self-test can
 * defeat each invariant in isolation.
 */
function operationsDrift({
  specOps,
  targeted,
  uncovered,
  implemented,
  basePath,
  codeOnly = CODE_ONLY_OPS,
  nonRest = NON_REST_TARGETS,
}) {
  const targetedOps = targeted.map((e) => e.op);
  const targetedSet = new Set(targetedOps);
  const uncoveredSet = new Set(uncovered.map((e) => e.op));
  const norm = (op) => {
    const [method, path] = op.split(" ");
    return `${method} ${normalizeOpPath(path)}`;
  };
  const targetedNorm = new Set(targetedOps.map(norm));
  const findings = [];
  const add = (label, items) => {
    if (items.length > 0) findings.push({ label, items });
  };

  // F. endpoints.txt -> spec.
  add(
    "operation(s) in endpoints.txt are NOT in the spec (removed/renamed/typo — check the path prefix):",
    targeted
      .filter((e) => !specOps.has(e.op))
      .map((e) => `${e.op} (line ${e.line})`),
  );

  // G. spec -> endpoints.txt U uncovered-ops.txt, both ways.
  add(
    "spec operation(s) neither targeted by endpoints.txt nor recorded in spec/uncovered-ops.txt (target them, or record why the SDK deliberately does not):",
    [...specOps].filter((op) => !targetedSet.has(op) && !uncoveredSet.has(op)),
  );
  add(
    "spec/uncovered-ops.txt entr(ies) the spec no longer defines (the operation was removed or renamed; drop the line):",
    uncovered
      .filter((e) => !specOps.has(e.op))
      .map((e) => `${e.op} (line ${e.line})`),
  );
  add(
    "spec/uncovered-ops.txt entr(ies) that ARE now targeted by endpoints.txt (remove them from uncovered-ops.txt — they are covered):",
    uncovered
      .filter((e) => targetedSet.has(e.op))
      .map((e) => `${e.op} (line ${e.line})`),
  );

  // H. src/client.ts <-> endpoints.txt, modulo NON_REST_TARGETS.
  //
  // The allowlist-free half of the policy. `codeOnly` is threaded through so
  // the self-test can hand this a non-empty one, but every entry it contains is
  // reported below rather than suppressing anything: an op the spec does not
  // define has no business being implemented, so it must surface here too.
  add(
    "operation(s) implemented in src/client.ts but NOT in endpoints.txt (add the line; if the pinned spec does not define the operation, delete the method — see CODE_ONLY_OPS):",
    [...implemented].filter((op) => !targetedNorm.has(op)),
  );
  add(
    "endpoints.txt entr(ies) with no implementing method in src/client.ts (remove them, or add to NON_REST_TARGETS if reached without a REST call):",
    targeted
      .filter((e) => !implemented.has(norm(e.op)) && !nonRest.has(e.op))
      .map((e) => `${e.op} (line ${e.line})`),
  );
  // CODE_ONLY_OPS must be empty. Unconditional, and deliberately not two
  // staleness checks: those only fire when something changes, so an operation no
  // spec has ever defined satisfies both and sits green forever (ENG-8616).
  add(
    "CODE_ONLY_OPS entr(ies) — the allowlist must be EMPTY (ENG-8616): an operation the pinned spec does not define must not be implemented. Delete the method, or wait for the released spec version that defines it and list it in endpoints.txt:",
    [...codeOnly],
  );
  add(
    "NON_REST_TARGETS entr(ies) that ARE implemented as a REST call in src/client.ts (remove them from the allowlist):",
    [...nonRest].filter((op) => implemented.has(norm(op))),
  );
  add(
    "NON_REST_TARGETS entr(ies) not listed in endpoints.txt (the allowlist only suppresses entries that are actually targeted; add the line or drop the grant):",
    [...nonRest].filter((op) => !targetedSet.has(op)),
  );

  // Coverage is reported per OPERATION, not per documented path. The spec
  // declares many operations twice — once on the legacy gateway route
  // (`/orders`) and once on the direct `/api/v1` route — pending ENG-8155, so
  // `specOps.size` counts paths. Dividing by it understated coverage by 21.6
  // points: "45 of 101" reads as 44.6% when the SDK covers 45 of 68 operations,
  // i.e. 66.2% (ENG-11847).
  //
  // Deliberately NOT applied to invariant G above. G requires endpoints.txt +
  // uncovered-ops.txt to account for every spec operation AS SPELLED, which is
  // what makes a spec release that adds an operation fail CI. Canonicalising
  // there would let a newly added path go unaccounted for whenever its twin was
  // already listed — trading a wrong number for a blind spot.
  //
  // The prefix is `basePath` — `API_BASE_PATH` read out of src/client.ts — not a
  // literal repeated here, for the same reason clientBasePath() exists.
  const canonical = (op) => canonicalOp(op, basePath);
  const canonicalSpecOps = new Set([...specOps].map(canonical));
  const canonicalTargeted = new Set(targetedOps.map(canonical));
  const covered = [...canonicalSpecOps].filter((op) =>
    canonicalTargeted.has(op),
  );
  const spellings = specOps.size - canonicalSpecOps.size;
  // Lines in uncovered-ops.txt that exist only because the twin spelling of an
  // operation this SDK DOES target must still be accounted for by invariant G.
  const twins = uncovered.filter((e) => canonicalTargeted.has(canonical(e.op)));
  const pct = canonicalSpecOps.size
    ? ((100 * covered.length) / canonicalSpecOps.size).toFixed(1)
    : "0.0";

  return {
    findings,
    summary:
      `SDK covers ${covered.length} of ${canonicalSpecOps.size} spec operation(s) (${pct}%) — ` +
      `${specOps.size} documented paths, ${spellings} of them a second spelling of an ` +
      `operation already counted. ${canonicalSpecOps.size - covered.length} operation(s) not ` +
      `targeted (${uncovered.length} lines in spec/uncovered-ops.txt, ${twins.length} of them ` +
      `the twin of a targeted operation). Off-contract allowlist: ${codeOnly.size} ` +
      `entr(ies) — policy is 0 (ENG-8616).`,
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

  const clientSrc = read(join(REPO, "src", "client.ts"));
  const basePath = clientBasePath(clientSrc);
  const ops = operationsDrift({
    specOps: specOperations(spec),
    targeted: parseOpsManifest(
      "endpoints.txt",
      read(join(REPO, "endpoints.txt")),
    ),
    uncovered: parseOpsManifest(
      "spec/uncovered-ops.txt",
      read(join(REPO, "spec", "uncovered-ops.txt")),
    ),
    implemented: implementedOps(clientSrc, basePath),
    basePath,
  });

  console.log(`Pinned API version : ${pin}`);
  console.log(`Vendored spec      : ${specPath}`);
  console.log(`Spec version       : v${specVersion}`);
  console.log(`Client base path   : ${basePath}`);
  console.log(
    `SDK targets ${targeted.length} schema(s); spec has ${specSchemas.length}.`,
  );
  console.log(
    `Checked ${enums.enumCount} spec enum(s) against models.ts (${allowlist.length} allowlisted member(s)).`,
  );
  console.log(ops.summary);

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

  // F/G/H. endpoints.txt <-> spec <-> src/client.ts (operations).
  for (const { label, items } of ops.findings) report(label, items);

  if (failures > 0) {
    console.error(`\n${failures} drift error(s).`);
    process.exit(1);
  }
  console.log(
    "\nOK: pin, vendored spec, schemas.txt, models.ts, enum members, and the operations manifest are all in sync.",
  );
}

// Run only when invoked as a script, so the module can also be imported.
//
// There WAS already a self-test (test/models.test.ts) — it copies this script
// into a temp dir and runs it end-to-end, which is why nothing here was ever
// imported. What was missing is a unit-level test of `operationsDrift`, the
// thing whose docstring promises purity "so the self-test can defeat each
// invariant in isolation"; test/spec-drift.test.ts is that (ENG-11847).
//
// `realpathSync` matters: the existing self-test runs the copy out of
// `os.tmpdir()`, which on macOS is a symlink (`/var/...` -> `/private/var/...`).
// `import.meta.url` is resolved, `process.argv[1]` is not, so comparing them raw
// made this guard false in exactly that test — main() silently did not run and
// every "must FAIL" assertion saw exit 0. An entry-point guard that skips the
// entry point is worse than no guard, so it resolves both sides.
const invokedAs = process.argv[1]
  ? pathToFileURL(realpathSync(process.argv[1])).href
  : "";
if (import.meta.url === invokedAs) main();

export { canonicalOp, operationsDrift };
