// Signed trading actions (D27, ENG-20652): the EIP-712 struct the engine
// checks on the eight order-path writes, carried in the `x-action-*` headers.
//
// A port of the exchange terminal's working signer
// (`eng/apps/exchange-terminal/lib/agent/trading-intent.ts` in nexus-xyz/nexus),
// which is itself `exchange-sec-utils/src/trading_intent.rs` field for field,
// with the request-to-struct mapping of `trading_request.rs`. The server
// rebuilds the struct from the request it receives, so the struct here is built
// from the exact JSON text that is sent, never from the caller's object.
//
// The encoder covers what these structs use (`string`, `bool`, `address`,
// `uintN`, nested structs and struct arrays) and throws on any other type.
// test/trading.test.ts holds it to the digests `trading_intent.rs` pins.

import { keccak_256 } from "@noble/hashes/sha3.js";

import { InvalidRequestError } from "./errors.js";

/**
 * The trading-action domain's chain id. The spec's "Signed trading actions"
 * section fixes the domain as `{name: "Nexus Exchange", version: "1",
 * chainId: 20056}` with no `verifyingContract` and no salt, on every
 * deployment; the deployment is bound by the struct's `domain` field instead.
 */
export const TRADING_CHAIN_ID = 20056;

type Field = { name: string; type: string };

/** The eight structs and `OrderParams`, in `trading_intent.rs`'s field order and Solidity types. */
const TYPES: Readonly<Record<string, readonly Field[]>> = {
  OrderParams: [
    { name: "marketId", type: "string" },
    { name: "side", type: "string" },
    { name: "orderType", type: "string" },
    { name: "price", type: "string" },
    { name: "quantity", type: "string" },
    { name: "timeInForce", type: "string" },
    { name: "reduceOnly", type: "bool" },
    { name: "stopPrice", type: "string" },
    { name: "triggerPrice", type: "string" },
    { name: "trailingOffsetBps", type: "string" },
    { name: "limitOffsetBps", type: "string" },
    { name: "stp", type: "string" },
    { name: "clientId", type: "string" },
    { name: "maxSlippageBps", type: "string" },
  ],
  PlaceOrder: envelope([{ name: "order", type: "OrderParams" }]),
  PlaceOrders: envelope([{ name: "orders", type: "OrderParams[]" }]),
  AmendOrder: envelope([
    { name: "marketId", type: "string" },
    { name: "orderId", type: "string" },
    { name: "price", type: "string" },
    { name: "size", type: "string" },
  ]),
  CancelOrder: envelope([
    { name: "marketId", type: "string" },
    { name: "orderId", type: "string" },
  ]),
  CancelAllOrders: envelope([{ name: "marketId", type: "string" }]),
  AdjustMargin: envelope([
    { name: "marketId", type: "string" },
    { name: "amount", type: "string" },
    { name: "direction", type: "string" },
  ]),
  SetMarginMode: envelope([
    { name: "marketId", type: "string" },
    { name: "marginMode", type: "string" },
  ]),
  SetLeverage: envelope([
    { name: "marketId", type: "string" },
    { name: "leverage", type: "uint32" },
  ]),
};

/** `account, domain, <route fields>, timestampMs, nonce`: every struct's shape. */
function envelope(fields: Field[]): Field[] {
  return [
    { name: "account", type: "address" },
    { name: "domain", type: "string" },
    ...fields,
    { name: "timestampMs", type: "uint64" },
    { name: "nonce", type: "uint64" },
  ];
}

const DOMAIN_TYPE: readonly Field[] = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
];

/** One of the eight structs, with its route fields (all but the envelope's four). */
export interface TradingAction {
  primaryType:
    | "PlaceOrder"
    | "PlaceOrders"
    | "AmendOrder"
    | "CancelOrder"
    | "CancelAllOrders"
    | "AdjustMargin"
    | "SetMarginMode"
    | "SetLeverage";
  fields: Readonly<Record<string, unknown>>;
}

/** The fields every struct shares besides the action. */
export interface TradingEnvelope {
  /** The account the action is for: `x-acting-account`, else the caller's own. */
  account: string;
  /** The deployment name (`devnet`, `prd-testnet`, …), never sent. */
  domain: string;
  timestampMs: number;
  nonce: number;
}

type Route =
  | { primaryType: TradingAction["primaryType"]; orderId?: undefined }
  | { primaryType: "AmendOrder" | "CancelOrder"; orderId: string };

/**
 * `trading_request.rs :: route`: which of the eight routes `method` + `path`
 * is, or null. A prefix such as `/api/v1` does not change the route;
 * `POST /orders/preview` and every read are not one.
 */
export function tradingRoute(method: string, path: string): Route | null {
  const segments = path
    .split("?")[0]
    .split("/")
    .filter((s) => s !== "");
  const last = segments.at(-1);
  const previous = segments.at(-2);
  if (last === undefined) return null;
  switch (method.toUpperCase()) {
    case "POST":
      if (last === "orders") return { primaryType: "PlaceOrder" };
      if (previous === "orders" && last === "batch")
        return { primaryType: "PlaceOrders" };
      if (previous === "account" && last === "margin")
        return { primaryType: "AdjustMargin" };
      if (previous === "account" && last === "margin-mode")
        return { primaryType: "SetMarginMode" };
      if (last === "leverage") return { primaryType: "SetLeverage" };
      return null;
    case "PATCH":
      return previous === "orders"
        ? { primaryType: "AmendOrder", orderId: last }
        : null;
    case "DELETE":
      if (last === "orders") return { primaryType: "CancelAllOrders" };
      return previous === "orders"
        ? { primaryType: "CancelOrder", orderId: last }
        : null;
    default:
      return null;
  }
}

// D27: "" signs the same as an absent field, so the venue refuses "" in these.
const OPTIONAL_ORDER_TEXT = [
  "price",
  "stop_price",
  "trigger_price",
  "stp",
  "client_id",
];
const OPTIONAL_AMEND_TEXT = ["price", "size"];

/**
 * The action `method` + `path` (with its query) + `body` carries, and the body
 * to send in its place, or null when the request is not one of the eight
 * routes. Empty optional strings are dropped from the body (D27), so the body
 * sent is the one signed. Throws {@link InvalidRequestError} on a request the
 * venue would refuse to verify.
 */
export function tradingRequest(
  method: string,
  path: string,
  body: string,
): { action: TradingAction; body: string } | null {
  const route = tradingRoute(method, path);
  if (route === null) return null;
  const queryStart = path.indexOf("?");
  const marketQuery = queryValue(
    queryStart === -1 ? "" : path.slice(queryStart + 1),
    "market_id",
  );
  const action = (
    primaryType: TradingAction["primaryType"],
    fields: Record<string, unknown>,
    sent = body,
  ) => ({ action: { primaryType, fields }, body: sent });

  switch (route.primaryType) {
    case "CancelOrder":
      return action("CancelOrder", {
        marketId: requiredQuery(marketQuery),
        orderId: route.orderId,
      });
    case "CancelAllOrders":
      if (marketQuery === "") {
        throw invalid('`market_id` was sent as "", which signs as absent');
      }
      return action("CancelAllOrders", { marketId: marketQuery ?? "" });
    default:
      break;
  }

  const parsed = parseBody(body);
  switch (route.primaryType) {
    case "PlaceOrder": {
      const fields = withoutEmpty(object(parsed), OPTIONAL_ORDER_TEXT);
      return action(
        "PlaceOrder",
        { order: orderParams(fields) },
        JSON.stringify(fields),
      );
    }
    case "PlaceOrders": {
      if (!Array.isArray(parsed)) throw invalid("the batch is not an array");
      const orders = parsed.map((o) =>
        withoutEmpty(object(o), OPTIONAL_ORDER_TEXT),
      );
      return action(
        "PlaceOrders",
        { orders: orders.map(orderParams) },
        JSON.stringify(orders),
      );
    }
    case "AmendOrder": {
      const fields = withoutEmpty(object(parsed), OPTIONAL_AMEND_TEXT);
      return action(
        "AmendOrder",
        {
          marketId: requiredQuery(marketQuery),
          orderId: route.orderId,
          price: optionalText(fields, "price"),
          size: optionalText(fields, "size"),
        },
        JSON.stringify(fields),
      );
    }
    case "AdjustMargin": {
      const fields = object(parsed);
      return action("AdjustMargin", {
        marketId: requiredText(fields, "market_id"),
        amount: requiredText(fields, "amount"),
        direction: requiredText(fields, "direction"),
      });
    }
    case "SetMarginMode": {
      const fields = object(parsed);
      return action("SetMarginMode", {
        marketId: requiredText(fields, "market_id"),
        marginMode: requiredText(fields, "margin_mode"),
      });
    }
    case "SetLeverage": {
      const fields = object(parsed);
      const leverage = optionalCount(fields, "leverage");
      if (leverage === null) throw invalid("`leverage` is missing");
      return action("SetLeverage", {
        marketId: requiredText(fields, "market_id"),
        leverage,
      });
    }
  }
}

/** `keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(action))`, the 32 bytes the key signs. */
export function tradingDigest(
  action: TradingAction,
  env: TradingEnvelope,
): Uint8Array {
  const account = env.account.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(account)) {
    throw invalid("the signed account is not a 0x-prefixed 20-byte address");
  }
  const domainSeparator = hashData("EIP712Domain", DOMAIN_TYPE, {
    name: "Nexus Exchange",
    version: "1",
    chainId: TRADING_CHAIN_ID,
  });
  const message = hashStruct(action.primaryType, {
    account,
    domain: env.domain,
    ...action.fields,
    timestampMs: env.timestampMs,
    nonce: env.nonce,
  });
  return keccak_256(
    concat([Uint8Array.from([0x19, 0x01]), domainSeparator, message]),
  );
}

// ─────────────────────────────────────────────────────────────── the encoder

const utf8 = (text: string) => new TextEncoder().encode(text);

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** A uint as one big-endian 32-byte word. */
function uintWord(value: bigint): Uint8Array {
  if (value < 0n || value >= 1n << 256n) throw invalid("uint out of range");
  const out = new Uint8Array(32);
  let rest = value;
  for (let i = 31; i >= 0 && rest > 0n; i -= 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

function typeLine(name: string, fields: readonly Field[]): string {
  return `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
}

/** The primary type's line, then every referenced struct's, sorted by name. */
function encodeType(primaryType: string): string {
  const found = new Set<string>();
  const visit = (name: string) => {
    if (found.has(name)) return;
    found.add(name);
    for (const field of TYPES[name]) {
      const base = field.type.replace(/\[\]$/, "");
      if (base in TYPES) visit(base);
    }
  };
  visit(primaryType);
  found.delete(primaryType);
  return [primaryType, ...[...found].sort()]
    .map((name) => typeLine(name, TYPES[name]))
    .join("");
}

function hashStruct(
  name: string,
  value: Readonly<Record<string, unknown>>,
): Uint8Array {
  return hashData(name, TYPES[name], value, encodeType(name));
}

function hashData(
  name: string,
  fields: readonly Field[],
  value: Readonly<Record<string, unknown>>,
  typeString = typeLine(name, fields),
): Uint8Array {
  const parts: Uint8Array[] = [keccak_256(utf8(typeString))];
  for (const f of fields) parts.push(encodeValue(f.type, value[f.name]));
  return keccak_256(concat(parts));
}

function encodeValue(type: string, value: unknown): Uint8Array {
  if (type.endsWith("[]")) {
    const item = type.slice(0, -2);
    return keccak_256(
      concat((value as readonly unknown[]).map((v) => encodeValue(item, v))),
    );
  }
  if (type in TYPES) {
    return hashStruct(type, value as Readonly<Record<string, unknown>>);
  }
  if (type === "string") return keccak_256(utf8(value as string));
  if (type === "bool") return uintWord(value === true ? 1n : 0n);
  if (type === "address") {
    const word = new Uint8Array(32);
    const hex = (value as string).slice(2);
    for (let i = 0; i < 20; i++) {
      word[12 + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return word;
  }
  if (/^uint\d+$/.test(type)) return uintWord(BigInt(value as number));
  throw invalid(`no encoder for EIP-712 type ${type}`);
}

// ─────────────────────────────────────────────────────── reading the request

type Fields = Readonly<Record<string, unknown>>;

function invalid(message: string): InvalidRequestError {
  return new InvalidRequestError(`signed trading action: ${message}`);
}

function parseBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw invalid("the body is not JSON");
  }
}

function object(value: unknown): Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid("the body is not a JSON object");
  }
  return value as Fields;
}

/** A copy of `fields` without the named keys whose value is "". Key order is kept. */
function withoutEmpty(
  fields: Fields,
  names: readonly string[],
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (value === "" && names.includes(name)) continue;
    kept[name] = value;
  }
  return kept;
}

function orderParams(fields: Fields): Record<string, unknown> {
  return {
    marketId: requiredText(fields, "market_id"),
    side: requiredText(fields, "side"),
    orderType: requiredText(fields, "order_type"),
    price: optionalText(fields, "price"),
    quantity: requiredText(fields, "quantity"),
    timeInForce: requiredText(fields, "time_in_force"),
    reduceOnly: reduceOnly(fields),
    stopPrice: optionalText(fields, "stop_price"),
    triggerPrice: optionalText(fields, "trigger_price"),
    trailingOffsetBps: digits(optionalCount(fields, "trailing_offset_bps")),
    limitOffsetBps: digits(optionalCount(fields, "limit_offset_bps")),
    stp: optionalText(fields, "stp"),
    clientId: optionalText(fields, "client_id"),
    maxSlippageBps: digits(optionalCount(fields, "max_slippage_bps")),
  };
}

function requiredText(fields: Fields, name: string): string {
  const value = fields[name];
  if (typeof value !== "string") {
    throw invalid(`\`${name}\` is missing or not a string`);
  }
  return value;
}

/** Absent and null sign as ""; "" itself is refused (D27). */
function optionalText(fields: Fields, name: string): string {
  const value = fields[name];
  if (value === undefined || value === null) return "";
  if (value === "")
    throw invalid(`\`${name}\` was sent as "", signs as absent`);
  if (typeof value !== "string") throw invalid(`\`${name}\` is not a string`);
  return value;
}

/** A u32 the venue reads with `as_u64`, or null when absent or null. */
function optionalCount(fields: Fields, name: string): number | null {
  const value = fields[name];
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 0xffffffff
  ) {
    throw invalid(`\`${name}\` is not a whole number in the u32 range`);
  }
  return value;
}

function digits(value: number | null): string {
  return value === null ? "" : String(value);
}

function reduceOnly(fields: Fields): boolean {
  const value = fields.reduce_only;
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw invalid("`reduce_only` is not a bool");
  return value;
}

function requiredQuery(value: string | null): string {
  if (value === null) throw invalid("`market_id` is missing from the query");
  return value;
}

/** The first `name=` value in `query`, percent-decoded as `trading_request.rs` does. */
function queryValue(query: string, name: string): string | null {
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    const key = eq === -1 ? pair : pair.slice(0, eq);
    if (key === name) return percentDecode(eq === -1 ? "" : pair.slice(eq + 1));
  }
  return null;
}

function percentDecode(raw: string): string {
  const bytes = utf8(raw);
  const decoded: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const byte = bytes[i];
    const pair = String.fromCharCode(bytes[i + 1] ?? 0, bytes[i + 2] ?? 0);
    if (byte === 0x25 && /^[0-9a-fA-F]{2}$/.test(pair)) {
      decoded.push(Number.parseInt(pair, 16));
      i += 3;
    } else {
      decoded.push(byte === 0x2b ? 0x20 : byte);
      i += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(decoded));
}
