/**
 * The tarball a publish would upload, packed and installed the way
 * scripts/verify-pack.mjs does it (ENG-18798). Shared by public-surface.mjs and
 * smoke.mjs, so both pre-publish checks look at the same artifact a consumer
 * gets, and never at src/ or a dist/ left over from an earlier build.
 *
 * Same safety properties as verify-pack: no shell (every command is an argument
 * array), and the consumer project installs with a temp pnpm store and
 * --ignore-workspace, so it cannot touch the developer's pnpm state. The caller
 * owns `work` and removes it.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/** Run a command with no shell; inherit stderr so build/install output is visible. */
export function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: REPO,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...opts,
  });
}

/**
 * Pack the package into `work` (prepack rebuilds dist/). release.yml publishes
 * with `npm publish`; `pnpm pack` gives the same dist/ (compared byte for byte,
 * ENG-18798 review), but drops `packageManager` and `prepack` from the packed
 * package.json, which nothing reads at install time. A `publishConfig` override
 * would differ between the two, so add one only with that in mind. The output
 * path is pinned with --out rather than parsed from stdout, because prepack's
 * output is interleaved there.
 */
export function pack(work) {
  const tarball = join(work, "package.tgz");
  run("pnpm", ["pack", "--out", tarball]);
  return tarball;
}

/**
 * Install `tarball` into a fresh consumer project at `<work>/consumer` and
 * return its path. Its only dependency is the tarball, so the package's own
 * dependencies resolve from the registry, as they would for a user.
 */
export function installConsumer(work, tarball) {
  const consumer = join(work, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({
      name: "prepublish-consumer",
      private: true,
      type: "module",
    }) + "\n",
  );
  run(
    "pnpm",
    [
      "add",
      tarball,
      "--ignore-workspace",
      "--store-dir",
      join(work, ".pnpm-store"),
    ],
    { cwd: consumer },
  );
  return consumer;
}
