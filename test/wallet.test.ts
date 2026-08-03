import { test } from "node:test";
import assert from "node:assert/strict";

import { EthSigner, SIGN_IN_MESSAGE } from "../src/wallet.js";
import { MissingCredentialsError, NexusExchangeError } from "../src/errors.js";

// Canonical Hardhat/ethers account #0: this private key derives to this
// address. The same key + vectors are used by the Rust SDK (nexus-exchange-rs
// src/auth/eth.rs), so the signatures below are byte-identical across SDKs and
// pin the exact EIP-191/EIP-712 schemes the server verifies.
const TEST_KEY =
  "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDR = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

// EIP-712 register-agent known-answer inputs (matching the Rust SDK's KATs).
const KAT_AGENT = "0x1234567890abcdef1234567890abcdef12345678";
const KAT_EXPIRES_MS = 1_782_000_000_000;
const KAT_NONCE = 1;
const KAT_CHAIN_ID = 393;

test("derives the known Ethereum address", () => {
  const signer = EthSigner.fromHex(TEST_KEY);
  assert.equal(signer.address, TEST_ADDR);
});

test("fromHex accepts a 0x prefix", () => {
  const signer = EthSigner.fromHex(`0x${TEST_KEY}`);
  assert.equal(signer.address, TEST_ADDR);
});

test("fromHex rejects a malformed private key", () => {
  assert.throws(() => EthSigner.fromHex("zz"), MissingCredentialsError);
  assert.throws(() => EthSigner.fromHex("00"), MissingCredentialsError); // 1 byte
  assert.throws(
    () => EthSigner.fromHex(TEST_KEY.slice(0, 60)),
    MissingCredentialsError,
  ); // 30 bytes
});

test("signIn builds the fixed login body", () => {
  const signer = EthSigner.fromHex(TEST_KEY);
  const req = signer.signIn();
  assert.equal(req.message, SIGN_IN_MESSAGE);
  assert.match(req.signature, /^0x[0-9a-f]{130}$/); // 65 bytes hex
});

// Cross-SDK golden vector: byte-identical to the Rust SDK's
// `sign_in_matches_known_answer`, produced by an independent ethers v6
// implementation. A wrong prefix, length encoding, or recovery-id convention
// would change this signature.
test("signIn matches the Rust known-answer vector", () => {
  const signer = EthSigner.fromHex(TEST_KEY);
  assert.equal(
    signer.signIn().signature,
    "0xff4ddf3b1af438fe00d02368ad8fa5fc5e57667e6826dbda3ddddc395a5287bb6eab0bc97652f6e7e1f08f665b868ca143da79e18dae8021799cdafc4af670ea1b",
  );
});

test("registerAgent builds the signed body", () => {
  const signer = EthSigner.fromHex(TEST_KEY);
  const req = signer.registerAgent({
    agent: KAT_AGENT,
    chainId: KAT_CHAIN_ID,
    expiresAtMs: KAT_EXPIRES_MS,
    nonce: KAT_NONCE,
    label: "my-bot",
  });
  assert.equal(req.wallet, TEST_ADDR);
  assert.equal(req.agent, KAT_AGENT);
  assert.equal(req.expires_at, KAT_EXPIRES_MS);
  assert.equal(req.nonce, KAT_NONCE);
  assert.equal(req.label, "my-bot");
  assert.match(req.signature, /^0x[0-9a-f]{130}$/);
});

// Cross-SDK golden vector: byte-identical to the Rust SDK's
// `register_agent_matches_known_answer`. This pins the EIP-712 domain
// (`name: "Nexus Exchange"`, `version: "1"`, chainId) and the
// `RegisterAgent(address agent,uint64 expiresAt,uint64 nonce)` typed data — so
// a wrong-but-self-consistent domain separator or field order is caught here.
test("registerAgent matches the Rust known-answer vector", () => {
  const signer = EthSigner.fromHex(TEST_KEY);
  const req = signer.registerAgent({
    agent: KAT_AGENT,
    chainId: KAT_CHAIN_ID,
    expiresAtMs: KAT_EXPIRES_MS,
    nonce: KAT_NONCE,
  });
  assert.equal(
    req.signature,
    "0x5df263ed6d1b619a72d436a01104f9036af6258cacf56dea973321cbe722a99550644eea6bf75656d48e982d2ce5db9ef13c4aced4539cf3c2ff87802b0197cc1b",
  );
});

test("registerAgent omits label when not provided", () => {
  const signer = EthSigner.fromHex(TEST_KEY);
  const req = signer.registerAgent({
    agent: KAT_AGENT,
    chainId: KAT_CHAIN_ID,
    expiresAtMs: KAT_EXPIRES_MS,
    nonce: KAT_NONCE,
  });
  assert.equal("label" in req, false);
  assert.equal(JSON.stringify(req).includes("label"), false);
});

test("registerAgent rejects a bad agent address", () => {
  const signer = EthSigner.fromHex(TEST_KEY);
  assert.throws(
    () =>
      signer.registerAgent({
        agent: "0x1234",
        chainId: KAT_CHAIN_ID,
        expiresAtMs: KAT_EXPIRES_MS,
        nonce: KAT_NONCE,
      }),
    NexusExchangeError,
  );
});

// ── EIP-712 domain safety (ENG-6453) ─────────────────────────────────────────
//
// The signing domain is per-network and server-authoritative (`/metadata`'s
// `signing_domain`). The spec is explicit that `chain_id: null` means "not
// published", NOT zero, and that a client which cannot obtain one must refuse to
// sign rather than guess — a wrong domain either fails verification or, worse,
// produces a signature that is valid on a *different* network.

test("registerAgent refuses chainId 0 rather than signing a zero domain", () => {
  const signer = EthSigner.fromHex(TEST_KEY);
  // 0 is not a real chain id, but it is what a missing one collapses to:
  // `Number(undefined ?? 0)`, an unset env var, or `chain_id: null ?? 0`.
  assert.throws(
    () =>
      signer.registerAgent({
        agent: KAT_AGENT,
        chainId: 0,
        expiresAtMs: KAT_EXPIRES_MS,
        nonce: KAT_NONCE,
      }),
    (err: unknown) => {
      assert.ok(err instanceof NexusExchangeError);
      assert.match(err.message, /chainId must be a positive integer/);
      assert.match(err.message, /metadata/);
      return true;
    },
  );
  assert.throws(
    () =>
      signer.registerAgent({
        agent: KAT_AGENT,
        chainId: 0n,
        expiresAtMs: KAT_EXPIRES_MS,
        nonce: KAT_NONCE,
      }),
    /chainId must be a positive integer/,
  );
});

test("registerAgent rejects negative and non-integer chain ids", () => {
  const signer = EthSigner.fromHex(TEST_KEY);
  const base = {
    agent: KAT_AGENT,
    expiresAtMs: KAT_EXPIRES_MS,
    nonce: KAT_NONCE,
  };
  for (const chainId of [-1, -1n]) {
    assert.throws(
      () => signer.registerAgent({ ...base, chainId }),
      /chainId must be a positive integer/,
    );
  }
  // A fractional or non-finite id would otherwise reach `BigInt()` and throw a
  // bare RangeError with no explanation of what is wrong.
  for (const chainId of [1.5, NaN, Infinity, -Infinity]) {
    assert.throws(
      () => signer.registerAgent({ ...base, chainId }),
      /chainId must be a safe integer or bigint/,
    );
  }
});

// The uint256 writer stops after 32 bytes, so before this guard an oversized
// value wrapped modulo 2^256: `2^256 + KAT_CHAIN_ID` encoded to the same word as
// `KAT_CHAIN_ID`, i.e. two different signing inputs with one digest.
test("an oversized chain id is rejected, not silently wrapped", () => {
  const signer = EthSigner.fromHex(TEST_KEY);
  const wrapped = (1n << 256n) + BigInt(KAT_CHAIN_ID);
  assert.throws(
    () =>
      signer.registerAgent({
        agent: KAT_AGENT,
        chainId: wrapped,
        expiresAtMs: KAT_EXPIRES_MS,
        nonce: KAT_NONCE,
      }),
    /does not fit in 32 bytes/,
  );
  // Proof the collision was real: the in-range id still signs, and had the
  // oversized one been accepted it would have produced this same signature.
  const ok = signer.registerAgent({
    agent: KAT_AGENT,
    chainId: KAT_CHAIN_ID,
    expiresAtMs: KAT_EXPIRES_MS,
    nonce: KAT_NONCE,
  });
  assert.match(ok.signature, /^0x[0-9a-f]{130}$/);
});

// `expires_at` / `nonce` are signed into the digest as the exact value passed but
// transmitted as JSON numbers via `Number(...)`. Above MAX_SAFE_INTEGER those
// disagree: 2^53+1 signs `…93` and would send `…92`, so the server rebuilds a
// different digest and verification fails for no visible reason.
test("an expiry or nonce that cannot round-trip as a JSON number is refused", () => {
  const signer = EthSigner.fromHex(TEST_KEY);
  const base = { agent: KAT_AGENT, chainId: KAT_CHAIN_ID };
  const unsafe = BigInt(Number.MAX_SAFE_INTEGER) + 2n; // 2^53 + 1
  assert.notEqual(BigInt(Number(unsafe)), unsafe); // the corruption is real

  assert.throws(
    () =>
      signer.registerAgent({ ...base, expiresAtMs: unsafe, nonce: KAT_NONCE }),
    /expiresAtMs must be a non-negative integer/,
  );
  assert.throws(
    () =>
      signer.registerAgent({
        ...base,
        expiresAtMs: KAT_EXPIRES_MS,
        nonce: unsafe,
      }),
    /nonce must be a non-negative integer/,
  );
  // Fractional / non-finite / negative would otherwise surface as a bare
  // RangeError out of `BigInt()`, outside the SDK's error hierarchy.
  for (const nonce of [1.5, NaN, Infinity, -1, -1n]) {
    assert.throws(
      () =>
        signer.registerAgent({ ...base, expiresAtMs: KAT_EXPIRES_MS, nonce }),
      /nonce must be a non-negative integer/,
    );
  }
  // The boundary itself is fine, as bigint or number, and both are transmitted
  // exactly as signed.
  for (const nonce of [
    Number.MAX_SAFE_INTEGER,
    BigInt(Number.MAX_SAFE_INTEGER),
  ]) {
    const body = signer.registerAgent({
      ...base,
      expiresAtMs: KAT_EXPIRES_MS,
      nonce,
    });
    assert.equal(body.nonce, Number.MAX_SAFE_INTEGER);
  }
});
