// Agent-key request signing — the `x-agent` / `x-timestamp` / `x-nonce` /
// `x-signature` scheme (the spec's `agentAuth` security scheme).
//
// An agent key is a secp256k1 keypair the wallet delegates trading to with
// `POST /agents/register` (see `EthSigner.registerAgent`). Once registered, the
// agent signs each request itself, so the wallet key never has to be online.
// {@link AgentSigner} is the credential that does that signing; hand it to the
// `Client` as `agentSigner` in place of `apiKey` / `apiSecret`.
//
// This is a port of the server verifier (`exchange-sec-utils::signing` +
// `accounts::agent_verify`), not a design, and it is byte-for-byte identical to
// the Rust SDK's `auth::AgentSigner` (nexus-exchange-rs#156). The canonical
// string is six LF-separated fields with no trailing newline:
//
//     {METHOD}\n{path}\n{query}\n{sha256hex(body)}\n{timestamp_ms}\n{nonce}
//
// NOTE the field order differs from the HMAC scheme in sign.ts: the method comes
// first and the timestamp comes after the body hash, so the HMAC builder cannot
// be reused. `path` is the same logical path the HMAC scheme signs (see
// client.ts); `query` is the exact encoded query string without the leading
// `?`, or an empty line when there is none.
//
// The digest is `keccak256(utf8(canonical))` with **no** EIP-191 prefix — a
// wallet library's `signMessage` / `personal_sign` would add one and produce a
// signature that recovers to some other address. The signature is recoverable
// secp256k1 ECDSA, deterministic (RFC 6979) and low-S (the server refuses
// high-S), sent as `0x` + 65-byte `r||s||v` with `v ∈ {27, 28}`.
//
// The server checks the timestamp is within ±30 s of its clock (reads and
// writes alike), that the signature recovers to `x-agent`, that the agent is
// registered on that host and unexpired, and — on mutating methods only — that
// `x-nonce` is strictly greater than the highest nonce it has accepted for that
// agent. Every failure is the same opaque `401`.
//
// secp256k1 and keccak256 come from the same audited @noble packages the
// EIP-712 registration path in wallet.ts already uses; no new dependency.

import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { MissingCredentialsError, NexusExchangeError } from "./errors.js";
import { bytesToHex } from "./sign.js";
import { tradingDigest, type TradingAction } from "./trading.js";
import { parsePrivateKey, signPrehash } from "./wallet.js";

/** The four agent-auth request headers, lower-case. */
export interface AgentAuthHeaders {
  /** The agent's address, lowercase `0x`-prefixed hex. */
  "x-agent": string;
  /** Unix epoch milliseconds, base 10. */
  "x-timestamp": string;
  /** Unsigned 64-bit nonce, base 10. */
  "x-nonce": string;
  /** `0x` + 65-byte `r||s||v` hex, `v ∈ {27, 28}`. */
  "x-signature": string;
}

/**
 * The signed trading action headers (D27): `x-action-signature`,
 * `x-action-timestamp`, `x-action-nonce`, and `x-acting-account` when the
 * action is for an account other than the signer's own (D30).
 */
export type ActionHeaders = Record<string, string>;

/** Options for {@link AgentSigner.fromHex}. */
export interface AgentSignerOptions {
  /**
   * The account that registered this agent, `0x`-prefixed 20-byte hex. A
   * signed trading action names the account it is for, so the agent needs it
   * to sign one (see {@link AgentSigner.actionHeaders}); the canonical-string
   * scheme does not.
   */
  account?: string;
}

/**
 * Validate and lowercase a 20-byte `0x` address.
 *
 * @internal Not re-exported from the package entry point.
 */
export function normalizeAccount(name: string, value: string): string {
  const lower = typeof value === "string" ? value.toLowerCase() : "";
  if (!/^0x[0-9a-f]{40}$/.test(lower)) {
    throw new NexusExchangeError(
      `${name} must be a 0x-prefixed 20-byte hex address`,
    );
  }
  return lower;
}

/** The parts of a request the agent signature covers. */
export interface AgentRequestParts {
  /** HTTP method, any case — the canonical string upper-cases it. */
  method: string;
  /**
   * The logical path the server authenticates, with no host and no query
   * string (e.g. `/api/v1/orders`). `Client` passes the same path it signs for
   * HMAC.
   */
  path: string;
  /** Exact encoded query string, no leading `?`. Defaults to `""`. */
  query?: string;
  /**
   * The exact body bytes sent. A string is UTF-8 encoded. Defaults to empty,
   * which hashes to `sha256("")`.
   */
  body?: Uint8Array | string;
  /** Unix epoch milliseconds, sent as `x-timestamp`. */
  timestampMs: number;
}

/** Validate a value that is both signed over and sent as a base-10 u64. */
function assertU64(name: string, v: number): void {
  if (!Number.isSafeInteger(v) || v < 0) {
    throw new NexusExchangeError(
      `${name} must be a non-negative safe integer, got ${String(v)}`,
    );
  }
}

function bodyBytes(body: Uint8Array | string | undefined): Uint8Array {
  if (body === undefined) return new Uint8Array(0);
  return typeof body === "string" ? new TextEncoder().encode(body) : body;
}

/**
 * Build the agent-key canonical string:
 * `{METHOD}\n{path}\n{query}\n{sha256hex(body)}\n{timestamp_ms}\n{nonce}`.
 *
 * Exposed so an integrator debugging an opaque `401` can compare it against the
 * spec's `x-nexus-test-vectors` field by field.
 */
export function agentCanonicalString(
  parts: AgentRequestParts & { nonce: number },
): string {
  assertU64("timestampMs", parts.timestampMs);
  assertU64("nonce", parts.nonce);
  return [
    parts.method.toUpperCase(),
    parts.path,
    parts.query ?? "",
    bytesToHex(sha256(bodyBytes(parts.body))),
    String(parts.timestampMs),
    String(parts.nonce),
  ].join("\n");
}

/**
 * Signs REST requests with a registered agent key: the `x-agent`,
 * `x-timestamp`, `x-nonce` and `x-signature` headers.
 *
 * Build one from the agent's 32-byte hex private key with
 * {@link AgentSigner.fromHex}, register {@link AgentSigner.address} with
 * `POST /agents/register` (signed by the wallet via `EthSigner.registerAgent`),
 * then pass it to the client as `agentSigner`:
 *
 * ```ts
 * const agent = AgentSigner.fromHex(process.env.AGENT_PRIVATE_KEY!);
 * const client = new Client({ network: Network.Testnet, agentSigner: agent });
 * await client.createOrder({ ... });
 * ```
 *
 * **Agent keys are trade-only and cannot withdraw.** The server refuses an
 * agent-signed `POST /api/v1/bridge/withdrawals` with `403`
 * (`AGENT_CANNOT_WITHDRAW`), `POST /withdrawals` needs the wallet's own EIP-712
 * signature, and ordinary transfers refuse any request carrying `x-agent`.
 * Agent keys also cannot manage agents (`GET /agents`, `DELETE /agents/{addr}`
 * answer `403 AGENT_KEY_FORBIDDEN`; the client refuses those locally) or mint the
 * legacy `POST /ws-tokens` token.
 *
 * ## Nonces
 *
 * The server requires each agent's nonce to strictly increase on mutating
 * requests; reads parse it but neither check nor consume it. A signer issues
 * `max(previous + 1, timestamp_ms)`, the same rule as the Rust SDK: strictly
 * increasing within one signer and roughly tracking the wall clock, so a
 * restarted process picks up above the nonces it issued before. JavaScript runs
 * the issue step synchronously, so concurrent callers on one signer always get
 * distinct, increasing values.
 *
 * Issued in order is not the same as **arriving** in order:
 *
 * - **Concurrent writes from one signer can be refused as replays**
 *   (ENG-17010). If two mutating requests from the same signer are in flight
 *   together and the one with the higher nonce reaches the server first, the
 *   other is rejected — with the same opaque `401` as a bad signature. This SDK
 *   does not queue requests per signer (the exchange frontend does). Until
 *   ENG-17010 is decided, keep one write in flight per agent key, or register a
 *   separate agent key for each concurrent writer. (The client's automatic
 *   retries, which cover `PUT` / `DELETE` among the writes, re-sign each
 *   attempt with a fresh, higher nonce, so a retry never replays its own.)
 * - **One agent key in several processes** can issue colliding nonces. Register
 *   one agent per process instead.
 *
 * ## Network scope
 *
 * An agent registration belongs to the host it was registered on; the
 * canonical string has no network component, so the same signer is simply
 * unknown (and `401`s) elsewhere.
 *
 * ## Signed trading actions (D27)
 *
 * On the eight order-path writes the engine checks an EIP-712 action signed by
 * an agent key, and once it enforces that it refuses an order without one. On a
 * network that names its deployment domain (`NetworkConfig.deploymentDomain`)
 * the client signs it with this agent, so build the signer with the account
 * that registered it: `AgentSigner.fromHex(key, { account })`.
 */
export class AgentSigner {
  readonly #privateKey: Uint8Array;
  readonly #address: string;
  readonly #account?: string;
  #lastNonce = 0;

  private constructor(
    privateKey: Uint8Array,
    address: string,
    account?: string,
  ) {
    this.#privateKey = privateKey;
    this.#address = address;
    this.#account = account;
  }

  /**
   * Build an agent signer from a 32-byte hex private key (`0x`-prefix
   * optional).
   *
   * Throws `MissingCredentialsError` if the key is not 32 bytes of valid hex or
   * is not a valid secp256k1 scalar. The error never echoes the key.
   */
  static fromHex(
    privateKey: string,
    options?: AgentSignerOptions,
  ): AgentSigner {
    const { key, address } = parsePrivateKey(privateKey);
    const account =
      options?.account === undefined
        ? undefined
        : normalizeAccount("account", options.account);
    return new AgentSigner(key, address, account);
  }

  /** The account that registered this agent, if it was given. */
  get account(): string | undefined {
    return this.#account;
  }

  /**
   * The agent's address, lowercase `0x`-prefixed hex: the value to register
   * with `POST /agents/register` and the value sent as `x-agent`.
   */
  get address(): string {
    return this.#address;
  }

  /**
   * Issue the next nonce, `max(last + 1, floorMs)`. Synchronous, so two callers
   * can never observe the same value.
   */
  nextNonce(floorMs: number): number {
    assertU64("floorMs", floorMs);
    const next = Math.max(this.#lastNonce + 1, floorMs);
    assertU64("nonce", next);
    this.#lastNonce = next;
    return next;
  }

  /**
   * Build the four agent-auth headers for a request, issuing the nonce from
   * this signer with `timestampMs` as its floor. This is what `Client` calls on
   * every signed attempt.
   */
  authHeaders(parts: AgentRequestParts): AgentAuthHeaders {
    assertU64("timestampMs", parts.timestampMs);
    return this.sign({ ...parts, nonce: this.nextNonce(parts.timestampMs) });
  }

  /**
   * Sign a request with an explicit `nonce`. Deterministic and side-effect
   * free (it does not advance this signer's nonce), which is what lets the
   * tests pin it against the spec's known-answer vectors. Prefer
   * {@link authHeaders} for real traffic: a caller-chosen nonce that is not
   * strictly increasing is refused on writes.
   */
  sign(parts: AgentRequestParts & { nonce: number }): AgentAuthHeaders {
    const canonical = agentCanonicalString(parts);
    const digest = keccak_256(new TextEncoder().encode(canonical));
    return {
      "x-agent": this.#address,
      "x-timestamp": String(parts.timestampMs),
      "x-nonce": String(parts.nonce),
      "x-signature": signPrehash(digest, this.#privateKey),
    };
  }

  /**
   * Sign a trading action (D27) and return its `x-action-*` headers, issuing
   * the nonce from this signer with `timestampMs` as its floor, the same
   * sequence {@link authHeaders} draws from. `Client` calls this on the eight
   * order-path writes when its network names a deployment domain.
   *
   * The struct's `account` is `actingAccount` when given (a subaccount, sent as
   * `x-acting-account`), else this agent's own {@link account}.
   */
  actionHeaders(args: {
    action: TradingAction;
    domain: string;
    timestampMs: number;
    actingAccount?: string;
  }): ActionHeaders {
    if (this.#account === undefined) {
      throw new MissingCredentialsError(
        "a signed trading action names the account it is for: build the " +
          "agent with `AgentSigner.fromHex(key, { account })`, the account " +
          "that registered it",
      );
    }
    assertU64("timestampMs", args.timestampMs);
    const nonce = this.nextNonce(args.timestampMs);
    const account = args.actingAccount ?? this.#account;
    const digest = tradingDigest(args.action, {
      account,
      domain: args.domain,
      timestampMs: args.timestampMs,
      nonce,
    });
    const headers: ActionHeaders = {
      "x-action-signature": signPrehash(digest, this.#privateKey),
      "x-action-timestamp": String(args.timestampMs),
      "x-action-nonce": String(nonce),
    };
    if (account !== this.#account) headers["x-acting-account"] = account;
    return headers;
  }

  /** Never render the key: `String(signer)` and JSON show only the address. */
  toString(): string {
    return `AgentSigner(${this.#address})`;
  }

  toJSON(): { address: string } {
    return { address: this.#address };
  }
}
