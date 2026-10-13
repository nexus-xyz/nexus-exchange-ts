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
 * read elsewhere, for proving the outcomes.
 *
 * In every mode, right after the install and before any testnet read, the
 * just-built probe is run three times that way, so exit codes 2 and 1 are
 * exercised on every run and not only described here:
 *   - http://127.0.0.1:1, where nothing listens: must exit 2 (unreachable);
 *   - scripts/release_gate/stub_server.py, which answers 200 with no markets:
 *     must exit 1 (failed);
 *   - stub_server.py 503, which answers every request with a 503: must exit 2,
 *     because an outage reads as unreachable, never as failed or passed.
 * Exit 0 (passed) is exercised only by the real read, which runs on a release
 * PR or a change to this gate. Each probe has a 180 s timeout. A wrong code, or
 * a timeout, is its own failure, named "(outcomes)". The probes run the built
 * probe directly with stdout and stderr captured, so they emit no annotations;
 * each prints one plain log line instead: case, exit code, first line of output.
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

// The SDK retries transient errors with backoff, so a shorter limit races it.
const PROBE_TIMEOUT_MS = 180_000;
const STUB_START_TIMEOUT_MS = 10_000;

/**
 * Run the probe in `consumer` against `baseUrl` and return the spawn result.
 * Stdout and stderr are both captured, so nothing the probe prints can become a
 * workflow annotation; a failure here is reported by the caller.
 */
function runProbe(consumer, baseUrl) {
  return spawnSync(process.execPath, ["probe.mjs"], {
    cwd: consumer,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: PROBE_TIMEOUT_MS,
    env: { ...process.env, NEXUS_SMOKE_BASE_URL: baseUrl },
  });
}

/** The first line a probe printed, defanged so it cannot read as an annotation. */
function firstLine(run) {
  const text = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
  return text.split("\n")[0].replace(/^::/, ": :");
}

/** What a probe run did, for a message: its exit, or why it never ran, and its line. */
function gotWhat(run) {
  const got =
    run.error?.code === "ETIMEDOUT"
      ? `the probe hit its ${PROBE_TIMEOUT_MS / 1000}s timeout`
      : run.error
        ? `the probe could not be started: ${run.error.message}`
        : `got ${run.status ?? run.signal}`;
  return `${got}. ${firstLine(run)}`;
}

/**
 * Start stub_server.py (answering with `status`, or 200 and no markets when
 * omitted) and resolve with the child and the port it printed on its first line
 * of stdout. The caller kills the child.
 */
function startStub(status) {
  const stub = spawn(
    "python3",
    [
      "-I",
      join(REPO, "scripts", "release_gate", "stub_server.py"),
      ...(status ? [String(status)] : []),
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => {
      stub.kill();
      reject(
        new Error(
          `the stub server printed no port within ${STUB_START_TIMEOUT_MS / 1000}s`,
        ),
      );
    }, STUB_START_TIMEOUT_MS);
    stub.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    stub.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(`the stub server exited (${code}) before printing a port`),
      );
    });
    stub.stdout.on("data", (chunk) => {
      out += chunk;
      const port = /^(\d+)\n/.exec(out)?.[1];
      if (port) {
        clearTimeout(timer);
        resolve({ stub, port });
      }
    });
  });
}

/**
 * One case: run the probe against `url` and expect exit `want`. Logs one plain
 * line (case, exit code, first line of output) and returns a message naming the
 * case and what it got when the code is wrong, or undefined when it is right.
 */
function expectExit(consumer, label, url, want, what) {
  const run = runProbe(consumer, url);
  const exit = run.error
    ? `no exit (${run.error.code})`
    : (run.status ?? run.signal);
  console.log(`probe ${label}: exit ${exit}: ${firstLine(run)}`);
  if (run.status !== want) {
    return `${label} case: expected exit ${want} from ${what}, ${gotWhat(run)}`;
  }
  // As the real read requires: the right code alone could be a crash that
  // happens to exit that way. The probe also prints its own `smoke: ...` line.
  if (!/^smoke: \S/.test((run.stdout ?? "").trim())) {
    return `${label} case: exited ${want} as expected, but printed no "smoke: ..." outcome line. ${firstLine(run)}`;
  }
  return undefined;
}

/**
 * Prove the probe's outcomes before trusting it with the testnet: nothing
 * listening is exit 2, an answer with no markets is exit 1, a 503 is exit 2.
 * Returns a message naming the case and the code it got, or undefined when all
 * three are right.
 */
async function checkOutcomes(consumer) {
  const wrong = expectExit(
    consumer,
    "unreachable",
    "http://127.0.0.1:1",
    2,
    "a base URL nothing listens on",
  );
  if (wrong) return wrong;
  for (const [label, status, want, what] of [
    ["empty", undefined, 1, "a server that answers with no markets"],
    ["outage", 503, 2, "a server that answers every request with 503"],
  ]) {
    let stub;
    try {
      let port;
      try {
        ({ stub, port } = await startStub(status));
      } catch (err) {
        return `${label} case: could not start scripts/release_gate/stub_server.py: ${err.message}`;
      }
      const wrong = expectExit(
        consumer,
        label,
        `http://127.0.0.1:${port}`,
        want,
        what,
      );
      if (wrong) return wrong;
    } finally {
      stub?.kill();
    }
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
    "the probe's outcomes hold: nothing listening exits 2, an empty answer exits 1, a 503 exits 2",
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
