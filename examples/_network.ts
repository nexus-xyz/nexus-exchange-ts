// Shared `--network` parsing for the examples. Not an example itself — hence the
// underscore.
//
// One copy instead of eight, for the network axis (ENG-6453).
//
// It also fixes an argv trap the duplicated version was one literal away from
// hitting. `process.argv[process.argv.indexOf("--network") + 1]` yields
// `process.argv[0]` — the node executable path — when the flag is absent,
// because `-1 + 1 === 0`. That was harmless while the result was only ever
// compared against a couple of literals and fell through to a default, but it
// is exactly the bug that made examples/portfolio.ts exit 1 on its own
// documented invocation as soon as the value was validated against a closed
// set. `flag()` returns `undefined` for an absent flag instead.

import { Network } from "../src/index.js";
import type { ClientOptions } from "../src/index.js";

/** Value of `--flag <value>`, or `undefined` when absent or trailing. */
export function flag(
  name: string,
  argv = process.argv.slice(2),
): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/**
 * Resolve `--network <testnet|local|mainnet>` into `ClientOptions`.
 * Defaults to testnet — play funds, never real ones.
 *
 * `mainnet` is accepted and will throw from the `Client` constructor with an
 * explanation: the public host is not live yet. That is deliberate, so the
 * examples exercise the same refusal a real caller gets rather than hiding it.
 */
export function networkOptions(argv = process.argv.slice(2)): ClientOptions {
  const value = flag("--network", argv) ?? "testnet";
  switch (value) {
    case "testnet":
      return { network: Network.Testnet };
    case "local":
      return { network: Network.Local };
    case "mainnet":
      return { network: Network.Mainnet };
    default:
      console.error(
        `--network must be one of: testnet, local, mainnet (got ${JSON.stringify(value)})`,
      );
      process.exit(1);
  }
}
