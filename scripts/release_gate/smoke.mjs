#!/usr/bin/env node
/**
 * Pre-publish smoke test (ENG-18798). Packs the package (see pack.mjs), installs the tarball into a throwaway consumer project, and runs one
 * unauthenticated read against the public testnet through it
 * (scripts/release_gate/smoke/probe.mjs). No keys, no writes.
 *
 *   node scripts/release_gate/smoke.mjs                pack, install, read
 *   node scripts/release_gate/smoke.mjs --install-only pack, install and link the probe; no testnet read (PRs that are not a release)
 *
 * Exit codes, kept apart on purpose: 0 passed, 1 failed, 2 testnet
 * unreachable. The workflow fails on 1 and on 2, under different names.
 * Unreachable is not a pass, and it is not the SDK's fault: re-run the job once
 * testnet answers.
 *
 * NEXUS_SMOKE_BASE_URL (a REST base, as `customNetwork` takes it) points the
 * read elsewhere, for proving the three outcomes locally.
 */
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO, installConsumer, pack } from "./pack.mjs";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--install-only")) {
  console.error("usage: node scripts/release_gate/smoke.mjs [--install-only]");
  process.exit(64);
}
const installOnly = args[0] === "--install-only";

function summary(title, body) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Testnet smoke: ${title}\n\n${body}\n`,
    );
  }
}

const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const built = `${pkg.name}@${pkg.version}`;
const work = mkdtempSync(join(tmpdir(), "exchange-ts-smoke-"));
let code;
let line;
let installError;
try {
  let consumer;
  try {
    consumer = installConsumer(work, pack(work));
  } catch (err) {
    // A pack or registry failure, before any read. Its own outcome, not a
    // stack trace and not "the SDK failed".
    installError = String(err?.message ?? err).split("\n")[0];
    throw err;
  }
  copyFileSync(
    join(REPO, "scripts", "release_gate", "smoke", "probe.mjs"),
    join(consumer, "probe.mjs"),
  );
  console.log(`installed the packed ${built} into a clean consumer`);

  const probe = spawnSync(
    process.execPath,
    ["probe.mjs", ...(installOnly ? ["--link-only"] : [])],
    { cwd: consumer, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  line = probe.stdout.trim();
  // A probe that crashed (an import that did not resolve, a signal) printed no
  // outcome of its own, and is a failure, never unreachable.
  code = [0, 1, 2].includes(probe.status) && line ? probe.status : 1;
  if (!line) {
    line = `smoke: failed: the probe exited ${probe.status ?? probe.signal} without an outcome`;
  }
} catch (err) {
  if (installError === undefined) throw err;
} finally {
  rmSync(work, { recursive: true, force: true });
}
if (installError !== undefined) {
  console.log(
    `::error title=prepublish-smoke (install failed)::The package could not be packed or installed into a clean consumer, so nothing was read. If the registry was down, re-run this job; otherwise the package does not install. ${installError}`,
  );
  summary("❌ INSTALL FAILED: nothing was read", installError);
  process.exit(1);
}
console.log(line);

if (installOnly) {
  if (code === 0) {
    console.log(
      "::notice title=prepublish-smoke (read not attempted)::Not a release PR: the package packed, installed into a clean consumer, and the probe's imports resolved against it. No testnet read was made. The read runs on the release PR.",
    );
    summary(
      "install only",
      `Not a release PR: \`${built}\` packed and installed into a clean consumer. No testnet read was attempted, so this is not a smoke pass.`,
    );
  } else {
    console.log(
      `::error title=prepublish-smoke (failed)::The packed package did not install and import cleanly. ${line}`,
    );
    summary("❌ FAILED", line);
  }
} else if (code === 0) {
  summary("✅ passed", line);
} else if (code === 2) {
  console.log(
    `::error title=prepublish-smoke (testnet unreachable)::NOT a pass: the testnet read got no usable answer, so nothing about this release was verified. Re-run this job once testnet answers. ${line}`,
  );
  summary("⚠️ TESTNET UNREACHABLE: not a pass", line);
} else {
  console.log(
    `::error title=prepublish-smoke (failed)::The packed package could not make an unauthenticated testnet read. ${line}`,
  );
  summary("❌ FAILED", line);
}
process.exit(code);
