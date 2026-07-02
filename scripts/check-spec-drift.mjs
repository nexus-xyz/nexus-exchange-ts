#!/usr/bin/env node
/**
 * Spec drift check — keeps `.api-version`, the vendored spec, the targeted
 * schema list, and the hand-written models all in lockstep. Mirrors the Rust
 * SDK's scripts/check_spec_drift.py, adapted to a *vendored* spec.
 *
 * Four independent invariants are enforced (all must hold):
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
function exportedModels() {
  const src = read(join(REPO, "src", "models.ts"));
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
  const models = exportedModels();
  const specSet = new Set(specSchemas);
  const targetedSet = new Set(targeted);

  console.log(`Pinned API version : ${pin}`);
  console.log(`Vendored spec      : ${specPath}`);
  console.log(`Spec version       : v${specVersion}`);
  console.log(
    `SDK targets ${targeted.length} schema(s); spec has ${specSchemas.length}.`,
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

  if (failures > 0) {
    console.error(`\n${failures} drift error(s).`);
    process.exit(1);
  }
  console.log(
    "\nOK: pin, vendored spec, schemas.txt, and models.ts are all in sync.",
  );
}

main();
