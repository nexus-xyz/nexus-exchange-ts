#!/usr/bin/env node
/**
 * Re-vendor the pinned OpenAPI spec (ENG-7963).
 *
 * This repo pins the Exchange API two ways at once: `.api-version` names a
 * released tag, and `spec/openapi.json` is a byte-pinned copy of that tag. Both
 * are the pin — invariant A in scripts/check-spec-drift.mjs ties them together —
 * so anything that advances one must advance the other. This script is the only
 * supported way to do that, for humans and for `.github/workflows/
 * spec-autobump.yml` alike. It is the TypeScript port of the monorepo's
 * `eng/apps/exchange/scripts/bump-api-spec.sh`.
 *
 * Usage:
 *   bump-api-spec.mjs <tag>            re-vendor spec/openapi.json + write .api-version
 *   bump-api-spec.mjs --check <tag>    exit 0 if the pin is at/ahead of <tag>,
 *                                      exit 3 if it is behind (nothing is written)
 *
 * The `--check` exit codes mirror the Rust SDK's scripts/sync_api_version.py so
 * the autobump gate reads the same in both repos: 3 means "a newer spec exists".
 *
 * Deliberately fetches the raw-at-tag file, NOT the GitHub release asset: the
 * asset's `download_count` is our *external* adoption signal, so first-party
 * bumps must not inflate it. (raw.githubusercontent.com fetches are not counted.)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC_REPO = "nexus-xyz/nexus-exchange-api";
const TAG_RE = /^v[0-9]+(\.[0-9]+){0,2}$/;

function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

/** Numeric components of a `vX.Y.Z` tag, zero-padded to three. */
function parts(tag) {
  const nums = tag.slice(1).split(".").map(Number);
  while (nums.length < 3) nums.push(0);
  return nums;
}

/** -1 / 0 / 1 comparing two validated `vX.Y.Z` tags. */
function compareTags(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

function pinnedTag() {
  const raw = readFileSync(join(REPO, ".api-version"), "utf8").trim();
  if (!TAG_RE.test(raw)) {
    die(`.api-version must look like vX.Y.Z (got: ${JSON.stringify(raw)})`);
  }
  return raw;
}

async function main(argv) {
  const check = argv.includes("--check");
  const tag = argv.find((a) => a !== "--check");
  if (!tag) {
    die(
      "usage: bump-api-spec.mjs <tag> | bump-api-spec.mjs --check <tag>  (e.g. v0.7.2)",
    );
  }
  // Validate strictly before the tag reaches a URL or a file: on the autobump
  // path it arrives from a `repository_dispatch` payload, i.e. untrusted data.
  if (!TAG_RE.test(tag))
    die(`tag must look like vX.Y.Z (got: ${JSON.stringify(tag)})`);

  const pinned = pinnedTag();

  if (check) {
    if (compareTags(pinned, tag) >= 0) {
      console.log(
        `Pin ${pinned} is already at or ahead of ${tag}; nothing to bump.`,
      );
      process.exit(0);
    }
    console.log(`Pin ${pinned} is behind ${tag}; a newer spec is available.`);
    process.exit(3);
  }

  const url = `https://raw.githubusercontent.com/${SPEC_REPO}/${tag}/openapi.json`;
  console.log(`Fetching ${url} ...`);
  const res = await fetch(url);
  if (!res.ok) {
    die(
      `no spec found at ${tag} in ${SPEC_REPO} (HTTP ${res.status}). Cut the release in the spec repo first.`,
    );
  }
  // Keep the bytes exactly as released — the vendored copy is byte-pinned, and
  // the spec-drift workflow's tag-match step compares it byte-for-byte.
  const body = await res.text();

  let version;
  try {
    version = JSON.parse(body)?.info?.version;
  } catch (err) {
    die(`${url} is not valid JSON: ${err.message}`);
  }
  if (typeof version !== "string" || `v${version}` !== tag) {
    die(
      `spec at ${tag} declares info.version ${JSON.stringify(version)}, which is not ${tag}. The release is mis-tagged; bumping would break invariant A.`,
    );
  }

  writeFileSync(join(REPO, "spec", "openapi.json"), body);
  writeFileSync(join(REPO, ".api-version"), `${tag}\n`);
  console.log(
    `Vendored spec/openapi.json ${version} and pinned .api-version to ${tag}.`,
  );
  console.log(
    "\nNext: run `pnpm run check:drift`. Re-vendoring puts the whole new spec in\n" +
      "scope, so a release that adds a schema, an enum member, or an operation will\n" +
      "fail the check until spec/schemas.txt, spec/uncovered-ops.txt, endpoints.txt\n" +
      "and src/models.ts are updated to match. That is the work the bump exists to\n" +
      "surface — it is not a problem with the bump.",
  );
}

await main(process.argv.slice(2));
