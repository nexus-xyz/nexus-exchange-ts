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

/**
 * Effective releaser config per package: root keys are defaults, and a matching
 * key in a `packages` entry overrides them.
 *
 * Both sides are the same shape upstream — the root composes
 * `allOf: [{$ref: ReleaserConfigOptions}]` and `packages`'
 * `additionalProperties` is that identical `$ref` — so every option is valid in
 * either place and the per-package one wins. Any check that reads only the root
 * can therefore be defeated by an override, which is why this resolves the merge
 * rather than reading the root directly.
 */
function effectiveConfigs(
  config: unknown,
): { name: string; options: Record<string, unknown> }[] {
  const { packages, ...root } = config as {
    packages?: Record<string, Record<string, unknown>>;
  } & Record<string, unknown>;
  const entries = Object.entries(packages ?? {});
  // No `packages` at all would mean nothing is released, but resolve the root on
  // its own rather than vacuously passing.
  if (entries.length === 0) return [{ name: "<root>", options: root }];
  return entries.map(([name, pkg]) => ({ name, options: { ...root, ...pkg } }));
}

// `release-as` forces every release to one literal version. It is NOT one-shot:
// as config it is persistent by design, which is exactly why it froze this repo
// — release-please re-proposed an already-published version forever and no later
// release could be cut. (The one-shot form is the `Release-As:` *commit footer*;
// to seed a first version, `initial-version` sets a starting point without the
// stickiness.) That bug stalled this repo at 0.1.0 (ENG-7413) and
// nexus-exchange-cli before it (ENG-4341), so it earns a standing guard.
test("release-please-config.json pins no release-as (ENG-7413, ENG-4341)", () => {
  const found = findReleaseAs(readJson("release-please-config.json"));
  assert.deepEqual(
    found,
    [],
    `release-as must never be committed — it is persistent config, so it ` +
      `freezes the version and blocks every later release. Found at: ` +
      `${found.join(", ")}. For a one-off version use the "Release-As:" ` +
      `commit footer; to seed a first version use "initial-version".`,
  );
});

// Without these, a 0.x repo would take release-please's default semantics and
// silently stop following the pre-1.0 policy documented in AGENTS.md: breaking
// changes bump the minor slot, features and fixes bump the patch slot. Checked
// per package, not at the root: `packages["."]["bump-minor-pre-major"] = false`
// would leave a root-only assertion green while the policy was off, and the next
// breaking change would then propose 1.0.0 to npm.
test("the pre-1.0 bump policy stays configured for every package", () => {
  const configs = effectiveConfigs(readJson("release-please-config.json"));
  assert.ok(configs.length > 0, "no packages resolved from the config");
  for (const { name, options } of configs) {
    assert.equal(
      options["bump-minor-pre-major"],
      true,
      `bump-minor-pre-major must be true for package "${name}" (root default ` +
        `or its own override) — otherwise a breaking change proposes 1.0.0`,
    );
    assert.equal(
      options["bump-patch-for-minor-pre-major"],
      true,
      `bump-patch-for-minor-pre-major must be true for package "${name}"`,
    );
  }
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
  // Prerelease and build metadata allowed: a `0.2.0-rc.1` is a legitimate
  // release-please output, and a stricter pattern would fail CI on a correct
  // state. The point of this assertion is that the version is semver-shaped at
  // all, not which channel it is on.
  assert.match(
    pkg.version,
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
  );
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
