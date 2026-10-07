import { test } from "node:test";
import assert from "node:assert/strict";

import { InvalidRequestError, roundPrice, roundSize } from "../src/index.js";
import { roundToIncrement } from "../src/markets.js";
import type { OrderSide } from "../src/models.js";

/**
 * Mirrors the `round_*` fixtures in nexus-exchange-rs `tests/markets.rs` (tick
 * 0.5, lot 0.001), so a drift between the SDKs shows up as a diff against that
 * file. The py and go SDKs carry the same table.
 *
 * Not carried over: rs's `Rounding::Nearest` cases (no side maps to it) and its
 * `Decimal::MAX` overflow case (`bigint` has no fixed width to overflow). The
 * "extra" rows are not in rs.
 *
 * [value, increment, awayFromZero (rs `Rounding::Up`, else `Down`), expected]
 */
const CASES: [string, string, boolean, string][] = [
  // round_price_snaps_to_tick
  ["50000.30", "0.5", false, "50000"],
  ["50000.30", "0.5", true, "50000.5"],
  ["50000.5", "0.5", false, "50000.5"],
  // round_size_snaps_to_lot
  ["1.23456", "0.001", false, "1.234"],
  ["1.23456", "0.001", true, "1.235"],
  // round_is_sign_symmetric_for_negatives
  ["-50000.3", "0.5", false, "-50000"],
  ["-50000.3", "0.5", true, "-50000.5"],
  ["-1.23456", "0.001", false, "-1.234"],
  ["-1.23456", "0.001", true, "-1.235"],
  // zero_increment_passes_through
  ["50000.3", "0", false, "50000.3"],
  ["1.23456", "0", true, "1.23456"],
  // round_result_is_clean_scale
  ["50001.0", "0.5", false, "50001"],
  // extra: ticks that float division gets wrong (ENG-19697), and -0
  ["2345.1", "0.1", false, "2345.1"],
  ["0.3", "0.1", true, "0.3"],
  ["123.456", "0.01", false, "123.45"],
  ["123.456", "0.01", true, "123.46"],
  ["7", "0.25", true, "7"],
  ["-0.0004", "0.001", false, "0"],
];

test("roundToIncrement matches the Rust SDK's fixtures", () => {
  for (const [value, inc, up, want] of CASES) {
    assert.equal(
      roundToIncrement(value, inc, up),
      want,
      `${value} / ${inc} up=${up}`,
    );
  }
});

test("roundPrice is side-aware and roundSize truncates", () => {
  const m = { tick_size: "0.5", lot_size: "0.001" };
  assert.equal(roundPrice(m, "50000.30", "Buy"), "50000");
  assert.equal(roundPrice(m, "50000.30", "Sell"), "50000.5");
  assert.equal(roundSize(m, "1.23456"), "1.234");
  assert.throws(
    () => roundPrice(m, "50000.30", "buy" as OrderSide),
    InvalidRequestError,
  );
  assert.throws(() => roundSize(m, "1e-3"), InvalidRequestError);
});
