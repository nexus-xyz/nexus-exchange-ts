// EVM wallet signing for the two wallet-authorized auth flows: EIP-191 session
// login (`signIn`) and EIP-712 agent-key registration (`registerAgent`).
//
// {@link EthSigner} holds a secp256k1 private key and produces the *signed
// request bodies* for those endpoints. It is a pure signer: deterministic,
// side-effect free, and ignorant of the network — the caller hands the body to
// the {@link Client} to send. Nonces and expiries are caller-supplied so signing
// carries no hidden clock. This mirrors the Rust SDK's `auth::EthSigner`
// byte-for-byte (see the cross-checked known-answer vectors in
// test/wallet.test.ts).
//
// Unlike request signing (see sign.ts, which rides on dependency-free Web
// Crypto), Ethereum signing needs secp256k1 ECDSA and keccak256 — neither of
// which Web Crypto provides — so this module uses the audited, dependency-free
// @noble/curves and @noble/hashes. They are isomorphic (browser + Node) and
// ship no install scripts.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

import { MissingCredentialsError, NexusExchangeError } from "./errors.js";
import { bytesToHex, hexToBytes } from "./sign.js";
import type { AgentRegistrationRequest, LoginRequest } from "./models.js";

/** The exact, fixed message the API requires for EIP-191 session login. */
export const SIGN_IN_MESSAGE = "Sign in to Nexus Exchange";

// EIP-712 domain, matching what the server verifies (and the Rust SDK's pinned
// known-answer vectors). NOTE: the OpenAPI prose for `POST /agents/register`
// reads `name: 'NexusExchange'` / `uint256` fields, but the server (and the
// reference Rust SDK's cross-checked vectors) actually use `"Nexus Exchange"`
// (with a space) and `uint64` struct fields — that is a spec-prose error, so we
// match the wire contract, not the prose. See test/wallet.test.ts.
const EIP712_DOMAIN_NAME = "Nexus Exchange";
const EIP712_DOMAIN_VERSION = "1";

/** Strip a leading `0x`/`0X`, if present. */
function strip0x(s: string): string {
  return s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
}

/** Concatenate byte arrays into one fresh `Uint8Array`. */
function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Left-pad a non-negative integer into a 32-byte big-endian ABI word (`uint256`). */
function u256(value: number | bigint): Uint8Array {
  let v = BigInt(value);
  if (v < 0n) {
    throw new NexusExchangeError("uint256 value must be non-negative");
  }
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0 && v > 0n; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Right-align a 20-byte address into a 32-byte ABI word (`address`). */
function addressWord(addr: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  out.set(addr, 12);
  return out;
}

/** Parse a `0x`-prefixed 20-byte hex address into bytes. */
function parseAddress(s: string, name: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(strip0x(s));
  } catch {
    throw new NexusExchangeError(`${name} must be hex`);
  }
  if (bytes.length !== 20) {
    throw new NexusExchangeError(`${name} must be 20 bytes`);
  }
  return bytes;
}

/**
 * EIP-191 `personal_sign` digest:
 * `keccak256("\x19Ethereum Signed Message:\n" + len(msg) + msg)`.
 */
function eip191Digest(message: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(
    `\x19Ethereum Signed Message:\n${message.length}`,
  );
  return keccak_256(concatBytes(prefix, message));
}

/**
 * EIP-712 digest for `RegisterAgent{agent, expiresAt, nonce}` under the
 * `Nexus Exchange` domain (no `verifyingContract`):
 * `keccak256(0x1901 || domainSeparator || hashStruct(message))`.
 */
function registerAgentDigest(
  agent: Uint8Array,
  expiresAtMs: number | bigint,
  nonce: number | bigint,
  chainId: number | bigint,
): Uint8Array {
  const enc = (s: string) => new TextEncoder().encode(s);

  const domainTypeHash = keccak_256(
    enc("EIP712Domain(string name,string version,uint256 chainId)"),
  );
  const domainSeparator = keccak_256(
    concatBytes(
      domainTypeHash,
      keccak_256(enc(EIP712_DOMAIN_NAME)),
      keccak_256(enc(EIP712_DOMAIN_VERSION)),
      u256(chainId),
    ),
  );

  const structTypeHash = keccak_256(
    enc("RegisterAgent(address agent,uint64 expiresAt,uint64 nonce)"),
  );
  const hashStruct = keccak_256(
    concatBytes(
      structTypeHash,
      addressWord(agent),
      u256(expiresAtMs),
      u256(nonce),
    ),
  );

  return keccak_256(
    concatBytes(Uint8Array.from([0x19, 0x01]), domainSeparator, hashStruct),
  );
}

/** Options for {@link EthSigner.registerAgent}. */
export interface RegisterAgentOptions {
  /** Agent Ethereum address to authorize (`0x`-prefixed, 20 bytes). */
  agent: string;
  /**
   * The EIP-712 domain chain id (the exchange's testnet chain id). Part of the
   * signed payload, so it must match what the server verifies against.
   */
  chainId: number | bigint;
  /**
   * Expiry as Unix milliseconds. The server expects it in `[now+1d, now+90d]`.
   * When omitted the server defaults to `now+30d`, but signing requires a
   * concrete value, so this is required here.
   */
  expiresAtMs: number | bigint;
  /**
   * Monotonic nonce. The current Unix timestamp in ms is a safe starting value.
   */
  nonce: number | bigint;
  /** Optional human-readable label for the agent (e.g. `"my-bot"`). */
  label?: string;
}

/**
 * An EVM wallet key that authorizes the wallet-signed auth flows.
 *
 * Construct from a 32-byte hex private key with {@link EthSigner.fromHex}. The
 * key is validated and the Ethereum address derived once at construction; the
 * secret is held as raw bytes and only used transiently while signing.
 *
 * Produces the *signed request bodies* for the two wallet-authorized endpoints:
 * - {@link signIn} → `POST /auth/login` (EIP-191 `personal_sign`).
 * - {@link registerAgent} → `POST /agents/register` (EIP-712).
 *
 * @example
 * ```ts
 * const signer = EthSigner.fromHex(process.env.WALLET_PRIVATE_KEY!);
 * const { token } = await client.signIn(signer);
 * ```
 */
export class EthSigner {
  readonly #privateKey: Uint8Array;
  readonly #address: string;

  private constructor(privateKey: Uint8Array, address: string) {
    this.#privateKey = privateKey;
    this.#address = address;
  }

  /**
   * Build a signer from a 32-byte hex private key (`0x`-prefix optional).
   *
   * Throws {@link MissingCredentialsError} if the key is not 32 bytes of valid
   * hex or is not a valid secp256k1 scalar.
   */
  static fromHex(privateKey: string): EthSigner {
    let bytes: Uint8Array;
    try {
      bytes = hexToBytes(strip0x(privateKey));
    } catch {
      throw new MissingCredentialsError("private key must be hex");
    }
    if (bytes.length !== 32) {
      throw new MissingCredentialsError("private key must be 32 bytes");
    }
    let pub: Uint8Array;
    try {
      // Uncompressed public key: 0x04 || X(32) || Y(32).
      pub = secp256k1.getPublicKey(bytes, false);
    } catch {
      throw new MissingCredentialsError("invalid secp256k1 private key");
    }
    // Address = keccak256(pubkey[1..])[12..], lowercase 0x-prefixed hex.
    const hash = keccak_256(pub.subarray(1));
    const address = `0x${bytesToHex(hash.subarray(12))}`;
    return new EthSigner(bytes, address);
  }

  /** The wallet's Ethereum address, lowercase `0x`-prefixed hex. */
  get address(): string {
    return this.#address;
  }

  /**
   * Sign the fixed login message ({@link SIGN_IN_MESSAGE}) with EIP-191
   * `personal_sign`, yielding the `POST /auth/login` request body.
   */
  signIn(): LoginRequest {
    const digest = eip191Digest(new TextEncoder().encode(SIGN_IN_MESSAGE));
    return {
      message: SIGN_IN_MESSAGE,
      signature: this.#signDigest(digest),
    };
  }

  /**
   * Sign an agent-key registration with EIP-712, yielding the
   * `POST /agents/register` request body. The returned `wallet` field is this
   * signer's own address.
   */
  registerAgent(options: RegisterAgentOptions): AgentRegistrationRequest {
    const agentBytes = parseAddress(options.agent, "agent address");
    const digest = registerAgentDigest(
      agentBytes,
      options.expiresAtMs,
      options.nonce,
      options.chainId,
    );
    const body: AgentRegistrationRequest = {
      wallet: this.#address,
      agent: `0x${bytesToHex(agentBytes)}`,
      expires_at: Number(options.expiresAtMs),
      nonce: Number(options.nonce),
      signature: this.#signDigest(digest),
    };
    if (options.label !== undefined) body.label = options.label;
    return body;
  }

  /**
   * Sign a 32-byte prehash, returning a `0x`-prefixed 65-byte `r||s||v`
   * signature with `v ∈ {27, 28}` (Ethereum convention). Deterministic
   * (RFC 6979) and low-S normalized (EIP-2), matching the reference SDKs.
   */
  #signDigest(digest: Uint8Array): string {
    // `recovered` format returns 65 bytes as recid(1) || r(32) || s(32); the
    // Ethereum wire order is r || s || v where v = 27 + recid.
    const recovered = secp256k1.sign(digest, this.#privateKey, {
      prehash: false,
      lowS: true,
      format: "recovered",
    });
    const out = new Uint8Array(65);
    out.set(recovered.subarray(1), 0);
    out[64] = 27 + recovered[0];
    return `0x${bytesToHex(out)}`;
  }
}
