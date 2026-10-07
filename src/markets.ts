/**
 * Snap a price to a market's tick and a size to its lot before submitting.
 *
 * The exchange rejects an order whose price is not a multiple of `tick_size`
 * or whose size is not a multiple of `lot_size`. These mirror `round_price` /
 * `round_size` in the Rust SDK's `src/markets.rs`, in exact `bigint`
 * arithmetic on the decimal strings (never float division, ENG-19697).
 */

import { InvalidRequestError } from "./errors.js";
import type { Decimal, Market, OrderSide } from "./models.js";

/**
 * Round `price` onto `market.tick_size`, on the side that never crosses: a
 * `"Buy"` rounds toward zero and a `"Sell"` away from zero (ENG-18543), the
 * Rust SDK's `Rounding::Down` and `Rounding::Up`. A zero tick returns `price`
 * unchanged. The result has no trailing zeros (`"50001.0"` is `"50001"`).
 *
 * @throws {InvalidRequestError} on any other side, or a non-decimal string.
 */
export function roundPrice(
  market: Pick<Market, "tick_size">,
  price: Decimal,
  side: OrderSide,
): Decimal {
  if (side !== "Buy" && side !== "Sell") {
    throw new InvalidRequestError(
      `side must be "Buy" or "Sell", got ${JSON.stringify(side)}`,
    );
  }
  return roundToIncrement(price, market.tick_size, side === "Sell");
}

/**
 * Round `size` onto `market.lot_size` toward zero, so it never rounds up into
 * more risk than asked: the Rust SDK's `round_size` with its default,
 * `Rounding::Down`. A zero lot returns `size` unchanged.
 *
 * @throws {InvalidRequestError} on a non-decimal string.
 */
export function roundSize(
  market: Pick<Market, "lot_size">,
  size: Decimal,
): Decimal {
  return roundToIncrement(size, market.lot_size, false);
}

/**
 * `markets.rs`'s `round_to_increment` for `Down` (`awayFromZero` false) and
 * `Up` (true). Both are sign-symmetric: toward and away from zero, not floor
 * and ceil. Not exported from the package; tests import it directly.
 */
export function roundToIncrement(
  value: Decimal,
  increment: Decimal,
  awayFromZero: boolean,
): Decimal {
  const [v, vScale] = parse(value);
  const [i, iScale] = parse(increment);
  if (i === 0n) return value;
  const scale = Math.max(vScale, iScale);
  const a = v * 10n ** BigInt(scale - vScale);
  const b = i * 10n ** BigInt(scale - iScale);
  let steps = a / b; // bigint division truncates toward zero
  if (awayFromZero && a % b !== 0n) steps += a < 0n === b < 0n ? 1n : -1n;
  return format(steps * b, scale);
}

const DECIMAL = /^-?\d+(\.\d+)?$/;

/** `"-1.50"` -> `[-150n, 2]`. */
function parse(s: Decimal): [bigint, number] {
  if (typeof s !== "string" || !DECIMAL.test(s)) {
    throw new InvalidRequestError(
      `expected a decimal string, got ${JSON.stringify(s)}`,
    );
  }
  const [int, frac = ""] = s.split(".");
  return [BigInt(int + frac), frac.length];
}

/** `[-150n, 2]` -> `"-1.5"`: trailing zeros dropped, and never `"-0"`. */
function format(n: bigint, scale: number): Decimal {
  const digits = (n < 0n ? -n : n).toString().padStart(scale + 1, "0");
  const int = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale).replace(/0+$/, "");
  return (n < 0n ? "-" : "") + int + (frac ? `.${frac}` : "");
}
