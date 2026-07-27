import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(REPO, name), "utf8"));
}

/**
 * Every `release-as` key anywhere in the config tree, as JSON paths. Recursive
 * rather than a top-level check, because the key is valid at both the root and
 * inside any entry of `packages` — a nested one is exactly as sticky.
 */
function findReleaseAs(node: unknown, path = "$"): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((v, i) => findReleaseAs(v, `${path}[${i}]`));
  }
  if (node !== null && typeof node === "object") {
    return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
      k === "release-as" ? [`${path}.${k}`] : findReleaseAs(v, `${path}.${k}`),
    );
  }
  return [];
}

// `release-as` forces every release to one literal version. It is a ONE-SHOT
// override — committing it freezes the version permanently, so release-please
// re-proposes an already-published version forever and no later release can be
// cut. That bug stalled this repo at 0.1.0 (ENG-7413) and nexus-exchange-cli
// before it (ENG-4341), so it is worth a standing guard rather than a comment.
test("release-please-config.json pins no release-as (ENG-7413, ENG-4341)", () => {
  const found = findReleaseAs(readJson("release-please-config.json"));
  assert.deepEqual(
    found,
    [],
    `release-as must never be committed — it freezes the version and blocks ` +
      `every later release. Found at: ${found.join(", ")}. If you need a ` +
      `one-off version, use the release-please "Release-As:" commit footer.`,
  );
});

// Without these, a 0.x repo would take release-please's default semantics and
// silently stop following the pre-1.0 policy documented in AGENTS.md: breaking
// changes bump the minor slot, features and fixes bump the patch slot.
test("the pre-1.0 bump policy stays configured", () => {
  const cfg = readJson("release-please-config.json") as Record<string, unknown>;
  assert.equal(cfg["bump-minor-pre-major"], true);
  assert.equal(cfg["bump-patch-for-minor-pre-major"], true);
});

// release-please bumps the version in three places at once (package.json, the
// manifest, and src/version.ts via `extra-files`). If any one of them is missed,
// the published package reports a version it isn't — so hold them in lockstep,
// the same way smoke.test.ts holds API_VERSION to `.api-version`.
test("package.json, the release manifest, and SDK_VERSION agree", () => {
  const pkg = readJson("package.json") as { version: string };
  const manifest = readJson(".release-please-manifest.json") as Record<
    string,
    string
  >;
  const src = readFileSync(join(REPO, "src", "version.ts"), "utf8");
  const sdkVersion = /export const SDK_VERSION = "([^"]+)"/.exec(src);

  assert.ok(sdkVersion, "could not parse SDK_VERSION from src/version.ts");
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(
    manifest["."],
    pkg.version,
    "the release manifest and package.json version have drifted",
  );
  assert.equal(
    sdkVersion[1],
    pkg.version,
    "SDK_VERSION and package.json version have drifted",
  );
});

// The `extra-files` generic updater rewrites whichever line carries the marker.
// It must be SDK_VERSION's: if it ever lands on API_VERSION, cutting a release
// would silently overwrite the pinned spec tag — corrupting the
// `X-Nexus-Api-Version` header and breaking the `.api-version` lockstep.
test("the release-please marker sits on SDK_VERSION, never API_VERSION", () => {
  const src = readFileSync(join(REPO, "src", "version.ts"), "utf8");
  const marked = src
    .split("\n")
    .filter((line) => line.includes("x-release-please-version"));

  assert.equal(marked.length, 1, "expected exactly one version marker");
  assert.match(marked[0]!, /SDK_VERSION/);
  assert.doesNotMatch(marked[0]!, /API_VERSION/);
});
