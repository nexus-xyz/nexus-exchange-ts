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
 * read elsewhere, for proving the three outcomes.
 *
 * In every mode, right after the install and before any testnet read, the
 * just-built probe is run twice that way, so the exit codes are exercised and
 * not only described here: against http://127.0.0.1:1, where nothing listens,
 * it must exit 2 (unreachable, never a pass); against
 * scripts/release_gate/stub_server.py, which answers 200 with no markets, it
 * must exit 1. Either code wrong is its own failure, named "(outcomes)". The
 * probes run the built probe directly, so the annotations below for an exit 1
 * or 2, which are expected there, are not printed for them.
 */
import { spawn, spawnSync } from "node:child_process";
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

/**
 * Run the probe in `consumer` against `baseUrl` and return the spawn result.
 * Its own output is not shown: a failure here is reported by the caller.
 */
function runProbe(consumer, baseUrl) {
  return spawnSync(process.execPath, ["probe.mjs"], {
    cwd: consumer,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NEXUS_SMOKE_BASE_URL: baseUrl },
  });
}

/** What a probe run did, for a message: its exit, or why it never ran, and its line. */
function gotWhat(run) {
  const got = run.error
    ? `the probe could not be started: ${run.error.message}`
    : `got ${run.status ?? run.signal}`;
  return `${got}. ${(run.stdout ?? "").trim()}`;
}

/**
 * Start stub_server.py and resolve with the child and the port it printed on
 * its first line of stdout. The caller kills the child.
 */
function startStub() {
  const stub = spawn(
    "python3",
    ["-I", join(REPO, "scripts", "release_gate", "stub_server.py")],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  return new Promise((resolve, reject) => {
    let out = "";
    stub.once("error", reject);
    stub.once("exit", (status) =>
      reject(
        new Error(`the stub server exited (${status}) before printing a port`),
      ),
    );
    stub.stdout.on("data", (chunk) => {
      out += chunk;
      const port = /^(\d+)\n/.exec(out)?.[1];
      if (port) resolve({ stub, port });
    });
  });
}

/**
 * Prove the probe's outcomes before trusting it with the testnet: nothing
 * listening is exit 2, an answer with no markets is exit 1. Returns a message
 * naming the case and the code it got, or undefined when both are right.
 */
async function checkOutcomes(consumer) {
  const down = runProbe(consumer, "http://127.0.0.1:1");
  if (down.status !== 2) {
    return `unreachable case: expected exit 2 from a base URL nothing listens on, ${gotWhat(down)}`;
  }
  let stub;
  try {
    let port;
    try {
      ({ stub, port } = await startStub());
    } catch (err) {
      return `empty case: could not start scripts/release_gate/stub_server.py: ${err.message}`;
    }
    const empty = runProbe(consumer, `http://127.0.0.1:${port}`);
    if (empty.status !== 1) {
      return `empty case: expected exit 1 from a server that answers with no markets, ${gotWhat(empty)}`;
    }
  } finally {
    stub?.kill();
  }
  return undefined;
}

const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const built = `${pkg.name}@${pkg.version}`;
const work = mkdtempSync(join(tmpdir(), "exchange-ts-smoke-"));
let code;
let line;
let installError;
let outcomeError;
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

  outcomeError = await checkOutcomes(consumer);
  if (outcomeError !== undefined) throw new Error(outcomeError);
  console.log(
    "the probe's outcomes hold: nothing listening exits 2, an empty answer exits 1",
  );

  const probe = spawnSync(
    process.execPath,
    ["probe.mjs", ...(installOnly ? ["--link-only"] : [])],
    { cwd: consumer, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  // `stdout` is null when the spawn itself failed (probe.error is set).
  line = (probe.stdout ?? "").trim();
  // A probe that crashed (an import that did not resolve, a signal) or never
  // started printed no outcome of its own, and is a failure, never unreachable.
  code = [0, 1, 2].includes(probe.status) && line ? probe.status : 1;
  if (!line) {
    line = probe.error
      ? `smoke: failed: the probe could not be started: ${probe.error.message}`
      : `smoke: failed: the probe exited ${probe.status ?? probe.signal} without an outcome`;
  }
} catch (err) {
  if (installError === undefined && outcomeError === undefined) throw err;
} finally {
  rmSync(work, { recursive: true, force: true });
}
if (outcomeError !== undefined) {
  console.log(
    `::error title=prepublish-smoke (outcomes)::The probe does not keep its outcomes apart, so a testnet read through it would prove nothing. ${outcomeError}`,
  );
  summary("❌ OUTCOMES WRONG: nothing was read", outcomeError);
  process.exit(1);
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
