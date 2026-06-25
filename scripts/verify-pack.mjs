#!/usr/bin/env node
/**
 * Published-artifact smoke test — proves the tarball npm would publish is
 * actually consumable.
 *
 * `npm publish` ships exactly what `npm pack` produces, which is *not* the
 * working tree: it is the `files` allowlist after `prepack` runs. A green
 * build/test on the source tree therefore does not prove the published package
 * resolves — a wrong `main`/`types`/`exports`, a `dist/` left out of `files`,
 * or an ESM resolution mistake only surfaces once a consumer installs it. So
 * here we pack the package, install that tarball into a throwaway project, and
 * import it the way a downstream consumer would, asserting the public surface
 * is reachable and the advertised types file exists.
 *
 * Safety properties:
 *   - Pure local: the package has no runtime dependencies, so installing the
 *     tarball touches no registry. We pass --no-audit/--no-fund and an isolated
 *     cache + prefix so a run can never mutate the developer's npm state.
 *   - No shell: every external command goes through execFileSync with an
 *     argument array, so nothing is interpolated into a shell string.
 *   - Self-cleaning: the temp dir and the packed tarball are always removed in
 *     a finally block, even on failure.
 *   - Version lockstep: asserts the built SDK_VERSION matches package.json, so
 *     a broken release-please version-bump annotation fails here, before any
 *     publish, rather than shipping a package whose self-reported version lies.
 *
 * Usage: node scripts/verify-pack.mjs
 */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Run a command with no shell; inherit stderr so build/install output is visible. */
function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: REPO,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...opts,
  });
}

const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const expectedName = pkg.name;
const expectedVersion = pkg.version;

// Create the tarball exactly as `npm publish` would (prepack rebuilds dist).
// --json prints a one-element array describing the tarball it wrote into REPO.
const packOut = run("npm", ["pack", "--json", "--silent"]);
const [{ filename }] = JSON.parse(packOut);
const tarball = resolve(REPO, filename);

const work = mkdtempSync(join(tmpdir(), "exchange-ts-pack-"));
try {
  // A throwaway consumer project. Isolate npm's cache/state inside `work` so
  // nothing leaks into the user's environment.
  writeFileSync(
    join(work, "package.json"),
    JSON.stringify({
      name: "verify-pack-consumer",
      private: true,
      type: "module",
    }) + "\n",
  );
  run(
    "npm",
    [
      "install",
      tarball,
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--cache",
      join(work, ".npm-cache"),
    ],
    {
      cwd: work,
    },
  );

  // The advertised types entry must actually be in the tarball.
  const typesPath = join(
    work,
    "node_modules",
    ...expectedName.split("/"),
    pkg.types,
  );
  if (!existsSync(typesPath)) {
    throw new Error(
      `declared types file is missing from the published package: ${pkg.types}`,
    );
  }

  // Import the package by its public name, the way a consumer would, and check
  // the surface resolves and self-reports the version we are about to publish.
  const probe = join(work, "probe.mjs");
  writeFileSync(
    probe,
    [
      `import * as sdk from ${JSON.stringify(expectedName)};`,
      `if (typeof sdk.SDK_VERSION !== "string" || sdk.SDK_VERSION.length === 0) {`,
      `  throw new Error("SDK_VERSION export is missing or not a non-empty string");`,
      `}`,
      `if (sdk.SDK_VERSION !== ${JSON.stringify(expectedVersion)}) {`,
      `  throw new Error("SDK_VERSION (" + sdk.SDK_VERSION + ") does not match package.json (${expectedVersion})");`,
      `}`,
      `console.log("import ok:", ${JSON.stringify(expectedName)}, sdk.SDK_VERSION);`,
    ].join("\n") + "\n",
  );
  run("node", [probe], { cwd: work, stdio: ["ignore", "inherit", "inherit"] });

  console.log(
    `\nverify-pack: ${expectedName}@${expectedVersion} packs and imports cleanly.`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
  rmSync(tarball, { force: true });
}
