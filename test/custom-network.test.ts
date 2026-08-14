// Custom networks (ENG-9825): a caller-supplied target this SDK does not name.
//
// Two things are under test, and the second matters more than the first. One,
// that a descriptor drives the transport — base URL, WS URL, signing domain.
// Two, that it cannot become the hole in the guardrails the network axis exists
// for: an undeclared target must fail closed, a label that is used as a
// credential key must be constrained, and a URL that would build a *wrong*
// request must be refused at construction rather than surface later as a
// signature error.
//
// Hosts here are RFC 2606 reserved names — `example.com` to illustrate,
// `example.invalid` where it must never resolve — because this package is a
// public artifact and naming a real deployment in it is the disclosure the
// feature exists to avoid.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  API_BASE_PATH,
  Client,
  NETWORKS,
  Network,
  customNetwork,
  networkConfig,
  baseUrlForNetwork,
} from "../src/client.js";
import type { CustomNetworkOptions, Funds } from "../src/client.js";
import { NexusExchangeError } from "../src/errors.js";

const NEVER_CALLED: typeof fetch = async () => {
  throw new Error("fetch must not be reached");
};

/** A minimal valid descriptor, for tests that vary exactly one field. */
function options(
  overrides: Partial<CustomNetworkOptions> = {},
): CustomNetworkOptions {
  return {
    label: "dev",
    baseUrl: `https://exchange.example.com${API_BASE_PATH}`,
    funds: "play",
    ...overrides,
  };
}

// ── The descriptor drives the client ─────────────────────────────────────────

test("a custom descriptor is accepted in place of the enum and drives the target", () => {
  const target = customNetwork(
    options({ funds: "play", faucet: true, signingChainId: 1234 }),
  );
  const client = new Client({ network: target, fetchImpl: NEVER_CALLED });

  assert.equal(client.network, target);
  assert.equal(client.networkConfig, target);
  assert.equal(client.label, "dev");
  assert.equal(client.funds, "play");
  assert.equal(client.hasFaucet, true);
  assert.equal(client.isRealFunds, false);
  assert.equal(client.baseUrl, "https://exchange.example.com/api/v1");
  // No wsUrl declared, so it is derived from the REST origin — the stream stays
  // on the host the ws token was minted on.
  assert.equal(client.wsUrl, "wss://exchange.example.com");
  assert.equal(client.requireSigningChainId(), 1234);
  // The bundle travels with the transport: what the client reports is what the
  // descriptor declared, with nothing left behind.
  assert.equal(client.networkConfig.baseUrl, client.baseUrl);
});

test("the descriptor is frozen, so a target cannot be retargeted after the fact", () => {
  const target = customNetwork(options());
  assert.ok(Object.isFrozen(target));
  assert.throws(() => {
    (target as unknown as Record<string, unknown>).baseUrl =
      "https://evil.example.invalid";
  }, TypeError);
  assert.throws(() => {
    (target as unknown as Record<string, unknown>).funds = "play";
  }, TypeError);
  const client = new Client({ network: target, fetchImpl: NEVER_CALLED });
  assert.equal(client.baseUrl, "https://exchange.example.com/api/v1");
});

test("a request is sent to the custom base, and host-root routes to its origin", async () => {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ token: "t" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = new Client({
    network: customNetwork(
      options({ baseUrl: "https://exchange.example.com/gateway/api/v1" }),
    ),
    apiKey: "nx_test",
    apiSecret: "00112233445566778899aabbccddeeff",
    fetchImpl,
  });

  await client.fetchMarketSummaries();
  await client.mintWsToken();

  assert.equal(
    urls[0],
    "https://exchange.example.com/gateway/api/v1/markets/summary",
  );
  // Host-root routes drop the whole base path, not just the /api/v1 suffix.
  assert.equal(urls[1], "https://exchange.example.com/ws/token");
});

test("a declared wsUrl is honoured, and origin-only", () => {
  const client = new Client({
    network: customNetwork(
      options({ wsUrl: "wss://stream.example.com", funds: "unknown" }),
    ),
    fetchImpl: NEVER_CALLED,
  });
  assert.equal(client.wsUrl, "wss://stream.example.com");
  assert.equal(client.baseUrl, "https://exchange.example.com/api/v1");
  // Trailing slashes are trimmed rather than doubling the path the ws client
  // appends.
  assert.equal(
    customNetwork(options({ wsUrl: "wss://stream.example.com/" })).wsUrl,
    "wss://stream.example.com",
  );
});

// A path here would be doubled: createWsClient appends "/ws" or "/stream".
test("a wsUrl with a path, or a plaintext one under https, is refused", () => {
  assert.throws(
    () => customNetwork(options({ wsUrl: "wss://stream.example.com/ws" })),
    (err: unknown) => {
      assert.ok(err instanceof NexusExchangeError);
      assert.match(err.message, /origin with no path/);
      return true;
    },
  );
  assert.throws(
    () => customNetwork(options({ wsUrl: "https://stream.example.com" })),
    /must use ws: or wss:/,
  );
  // A ws:// stream under an https:// base downgrades the socket the short-lived
  // ws token is spent on.
  assert.throws(
    () => customNetwork(options({ wsUrl: "ws://stream.example.com" })),
    /downgrades the socket/,
  );
  // ...but plaintext throughout is a legitimate local setup.
  assert.equal(
    customNetwork(
      options({
        baseUrl: "http://localhost:9099/api/v1",
        wsUrl: "ws://localhost:9099",
      }),
    ).wsUrl,
    "ws://localhost:9099",
  );
});

// A scheme is case-insensitive, and the base is stored byte-exact, so the
// downgrade check has to compare parsed schemes rather than the raw string —
// otherwise "HTTPS://" reads as not-TLS and the plaintext socket is accepted.
test("the ws downgrade check is case-insensitive about the base's scheme", () => {
  for (const baseUrl of [
    "HTTPS://exchange.example.com/api/v1",
    "Https://exchange.example.com/api/v1",
  ]) {
    assert.throws(
      () =>
        customNetwork(options({ baseUrl, wsUrl: "ws://stream.example.com" })),
      /downgrades the socket/,
      `expected ${baseUrl} to refuse a plaintext stream`,
    );
  }
  // The mixed-case base is still accepted on its own — only the pairing is
  // refused — and it is kept byte-exact.
  assert.equal(
    customNetwork(options({ baseUrl: "HTTPS://exchange.example.com/api/v1" }))
      .baseUrl,
    "HTTPS://exchange.example.com/api/v1",
  );
});

// ── Funds: required, tri-state, and failing closed ───────────────────────────

test("funds must be declared explicitly — there is no default", () => {
  for (const funds of [undefined, null, "", "playfunds", "PLAY", true, 1]) {
    assert.throws(
      () =>
        customNetwork({
          ...options(),
          funds: funds as Funds,
        }),
      (err: unknown) => {
        assert.ok(err instanceof NexusExchangeError);
        assert.match(err.message, /requires an explicit `funds`/);
        return true;
      },
      `expected funds ${JSON.stringify(funds)} to be refused`,
    );
  }
  for (const funds of ["real", "play", "unknown"] as const) {
    assert.equal(customNetwork(options({ funds })).funds, funds);
  }
});

// The whole point of the tri-state: "unknown" must not read as "play" anywhere.
test("an undeclared target fails closed on every funds guardrail", async () => {
  const client = new Client({
    network: customNetwork(options({ funds: "unknown" })),
    apiKey: "nx_test",
    apiSecret: "00112233445566778899aabbccddeeff",
    fetchImpl: NEVER_CALLED,
  });

  assert.equal(client.funds, "unknown");
  // Fails closed: undeclared is reported as real-funds, not as play.
  assert.equal(client.isRealFunds, true);
  assert.equal(client.hasFaucet, false);
  // Refused locally — NEVER_CALLED proves nothing was built, signed or sent —
  // and as a rejection, so a caller's `.catch(…)` sees it.
  for (const claim of [
    () => client.claimFaucet(),
    () => client.claimCredit(),
  ]) {
    await assert.rejects(claim(), (err: unknown) => {
      assert.ok(err instanceof NexusExchangeError);
      assert.match(err.message, /does not declare what its funds are worth/);
      return true;
    });
  }
});

test("the funding helpers claim only for a declared play-funds target with a faucet", async () => {
  const cases: {
    funds: Funds;
    faucet?: boolean;
    claims: boolean;
    because?: RegExp;
  }[] = [
    { funds: "play", faucet: true, claims: true },
    { funds: "play", claims: false, because: /no faucet, so there is nothing/ },
    { funds: "real", claims: false, because: /REAL FUNDS/ },
    { funds: "unknown", claims: false, because: /does not declare/ },
  ];

  for (const { funds, faucet, claims, because } of cases) {
    let sent = 0;
    const client = new Client({
      network: customNetwork(options({ funds, faucet })),
      apiKey: "nx_test",
      apiSecret: "00112233445566778899aabbccddeeff",
      fetchImpl: async () => {
        sent += 1;
        return new Response(
          JSON.stringify({ amount: "1", available_at_ms: 0 }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    });

    if (claims) {
      await client.claimFaucet();
      assert.equal(
        sent,
        1,
        `${funds}/${faucet}: expected the claim to be sent`,
      );
    } else {
      await assert.rejects(client.claimFaucet(), (err: unknown) => {
        assert.ok(err instanceof NexusExchangeError);
        assert.match(err.message, because!);
        return true;
      });
      assert.equal(sent, 0, `${funds}/${faucet}: nothing may be sent`);
    }
  }
});

// "Not real money" does not imply "there is a faucet", and a faucet flag on a
// target whose claims can never be made would be silently useless.
test("a faucet may only be declared alongside play funds", () => {
  for (const funds of ["real", "unknown"] as const) {
    assert.throws(
      () => customNetwork(options({ funds, faucet: true })),
      (err: unknown) => {
        assert.ok(err instanceof NexusExchangeError);
        assert.match(err.message, /declares a faucet/);
        return true;
      },
      `expected funds: ${funds} + faucet: true to be refused`,
    );
    // Declaring it false, or omitting it, is fine.
    assert.equal(
      customNetwork(options({ funds, faucet: false })).faucet,
      false,
    );
    assert.equal(customNetwork(options({ funds })).faucet, false);
  }
  assert.throws(
    () => customNetwork(options({ faucet: "yes" as unknown as boolean })),
    /`faucet` must be a boolean/,
  );
});

// ── The signing domain is never guessed ──────────────────────────────────────

test("a target with no declared chain id refuses to supply one for signing", () => {
  const client = new Client({
    network: customNetwork(options()),
    fetchImpl: NEVER_CALLED,
  });
  assert.equal(client.signingDomain.chainId, null);
  assert.throws(
    () => client.requireSigningChainId(),
    (err: unknown) => {
      assert.ok(err instanceof NexusExchangeError);
      assert.match(err.message, /refuses\s+to sign rather than guess one/);
      return true;
    },
  );
  // Every named network is in the same position, by design.
  for (const network of Object.values(Network)) {
    if (NETWORKS[network].baseUrl === null) continue;
    assert.throws(
      () =>
        new Client({
          network,
          fetchImpl: NEVER_CALLED,
        }).requireSigningChainId(),
      /refuses\s+to sign rather than guess one/,
    );
  }
});

test("only the chain id is caller-supplied; name and version stay fixed", () => {
  const target = customNetwork(options({ signingChainId: 8453 }));
  assert.deepEqual(target.signingDomain, {
    name: "Nexus Exchange",
    version: "1",
    chainId: 8453,
  });
  assert.ok(Object.isFrozen(target.signingDomain));
  // `0` is the value a missing chain id collapses to, so it is rejected rather
  // than signed under.
  for (const chainId of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
    assert.throws(
      () => customNetwork(options({ signingChainId: chainId })),
      /signingChainId must be a positive safe integer/,
      `expected chain id ${chainId} to be refused`,
    );
  }
});

// ── The label is a credential-storage key ────────────────────────────────────

test("a label is required and constrained to safe key characters", () => {
  assert.equal(customNetwork(options({ label: "  dev  " })).label, "dev");
  for (const label of [
    "dev",
    "one-two",
    "one_two",
    "a.b",
    "A0",
    "x".repeat(64),
  ]) {
    assert.equal(customNetwork(options({ label })).label, label);
  }

  const rejected = [
    // Missing or empty.
    undefined,
    null,
    "",
    "   ",
    // Path traversal and separators: one target must not be able to address
    // another target's stored credentials.
    ".",
    "..",
    "../other",
    "one/two",
    "one\\two",
    // Namespace separators and shell/URL metacharacters.
    "one:two",
    "one two",
    "one\ttwo",
    "one\ntwo",
    "one two",
    "one=two",
    "one%2ftwo",
    // Normalization makes non-ASCII keys ambiguous.
    "dév",
    "ｄｅｖ",
    // Over the cap.
    "x".repeat(65),
  ];
  for (const label of rejected) {
    assert.throws(
      () => customNetwork(options({ label: label as string })),
      (err: unknown) => {
        assert.ok(err instanceof NexusExchangeError);
        assert.match(err.message, /label/);
        return true;
      },
      `expected label ${JSON.stringify(label)} to be refused`,
    );
  }
});

// ── The caller-supplied URL is a new input, so it is validated ───────────────

test("a base URL that would build a wrong request is refused at construction", () => {
  const rejected: [unknown, RegExp][] = [
    [undefined, /must be a non-empty absolute/],
    ["", /must be a non-empty absolute/],
    [42, /must be a non-empty absolute/],
    // Relative: in a browser these resolve against the hosting page's origin,
    // which would send the signed headers there.
    ["/api/v1", /absolute http or https URL/],
    ["//exchange.example.com/api/v1", /absolute http or https URL/],
    ["not-a-url", /absolute http or https URL/],
    ["ftp://exchange.example.com", /must use http: or https:/],
    ["ws://exchange.example.com", /must use http: or https:/],
    ["file:///etc/passwd", /must use http: or https:/],
    // Userinfo is refused, not stripped: the base is printed in errors and logs.
    ["https://user:pw@exchange.example.com/api/v1", /user:password@/],
    ["https://user@exchange.example.com/api/v1", /user:password@/],
    // Unparseable *and* carrying userinfo: the earlier rejection echoes the URL,
    // so the password must be redacted out of it.
    ["https://user:pw@", /<redacted>@/],
    // A query swallows the appended path, so the request lands somewhere other
    // than where its signature says.
    ["https://exchange.example.com/api/v1?token=x", /must not.+carry a query/s],
    ["https://exchange.example.com/api/v1#frag", /must not.+carry a fragment/s],
    // Silently stripped by the URL parser, so the base used would not be the one
    // written here.
    ["https://exchange.example.com/api/v1\n", /whitespace or control/],
    ["https://exchange.example.com\t/api/v1", /whitespace or control/],
    [" https://exchange.example.com/api/v1", /whitespace or control/],
    ["https://exchange.example.com/api /v1", /whitespace or control/],
  ];
  for (const [baseUrl, expected] of rejected) {
    assert.throws(
      () => customNetwork(options({ baseUrl: baseUrl as string })),
      (err: unknown) => {
        assert.ok(err instanceof NexusExchangeError);
        assert.match(err.message, expected);
        return true;
      },
      `expected baseUrl ${JSON.stringify(baseUrl)} to be refused`,
    );
  }

  // Trailing slashes are trimmed rather than doubling the appended path.
  assert.equal(
    customNetwork(options({ baseUrl: "https://exchange.example.com/api/v1//" }))
      .baseUrl,
    "https://exchange.example.com/api/v1",
  );
  // A port, and a base with no path at all, are both fine.
  assert.equal(
    customNetwork(options({ baseUrl: "http://localhost:9099" })).baseUrl,
    "http://localhost:9099",
  );
});

// Unlike the `baseUrl` shortcut — the field people paste a py/mcp gateway base
// into — a declared descriptor owns its own URL layout. Refusing the gateway
// prefix here would make the variant unusable for the deployments it exists for,
// which are reachable only through it.
test("a gateway-prefixed base is refused as a shortcut but allowed when declared", () => {
  const gateway = "https://exchange.example.com/api/exchange";
  assert.throws(
    () => new Client({ baseUrl: gateway, fetchImpl: NEVER_CALLED }),
    /must not point at the legacy/,
  );
  const client = new Client({
    network: customNetwork(options({ baseUrl: gateway })),
    fetchImpl: NEVER_CALLED,
  });
  assert.equal(client.baseUrl, gateway);
});

// ── The `baseUrl` shortcut is sugar for an undeclared target ─────────────────

test("a bare baseUrl builds an undeclared custom target, replacing the network", () => {
  const client = new Client({
    network: Network.Testnet,
    baseUrl: "https://exchange.example.com/api/v1",
    fetchImpl: NEVER_CALLED,
  });

  // The named network is gone: one mechanism for pointing at a host, and it
  // carries no safety metadata borrowed from elsewhere.
  assert.notEqual(client.network, Network.Testnet);
  assert.equal(client.label, "custom");
  assert.equal(client.funds, "unknown");
  assert.equal(client.hasFaucet, false);
  assert.equal(client.isRealFunds, true);
  assert.equal(client.signingDomain.chainId, null);
  assert.equal(client.baseUrl, "https://exchange.example.com/api/v1");
  assert.equal(client.wsUrl, "wss://exchange.example.com");
});

// The shortcut now gets the same URL hygiene as a declared descriptor. Each of
// these was previously accepted and would build a *wrong* request rather than
// fail: the query in particular swallows the appended path, so the request lands
// somewhere other than where its HMAC signature says it does.
test("the baseUrl shortcut refuses a URL that would misbuild requests", () => {
  const rejected: [string, RegExp][] = [
    ["https://u:pw@exchange.example.com/api/v1", /user:password@/],
    ["https://exchange.example.com/api/v1?token=x", /carry a query string/],
    ["https://exchange.example.com/api/v1#frag", /carry a fragment/],
    ["https://exchange.example.com/api/v1\n", /whitespace or control/],
  ];
  for (const [baseUrl, expected] of rejected) {
    assert.throws(
      () => new Client({ baseUrl, fetchImpl: NEVER_CALLED }),
      (err: unknown) => {
        assert.ok(err instanceof NexusExchangeError);
        assert.match(err.message, expected);
        // Named for the option the caller actually passed.
        assert.match(err.message, /`baseUrl` option/);
        return true;
      },
      `expected baseUrl ${JSON.stringify(baseUrl)} to be refused`,
    );
  }
});

// Two declarations of the same thing, where silently preferring one is how a
// client ends up on a host whose funds classification came from the other.
test("a descriptor and a baseUrl cannot be combined", () => {
  assert.throws(
    () =>
      new Client({
        network: customNetwork(options()),
        baseUrl: "https://other.example.invalid/api/v1",
        fetchImpl: NEVER_CALLED,
      }),
    (err: unknown) => {
      assert.ok(err instanceof NexusExchangeError);
      assert.match(err.message, /not both/);
      return true;
    },
  );
});

// ── Untyped input reaches a published package ────────────────────────────────

// A plain object satisfies NetworkConfig at compile time while carrying an
// unusable base, an unsafe label, or no funds declaration at all — and untyped
// callers, JSON.parse and env vars bypass the types entirely. So the constructor
// re-validates rather than trusting the type.
test("a hand-written descriptor is re-validated, not trusted", () => {
  const bad = [
    { label: "../other", baseUrl: "https://h.example.com", funds: "play" },
    { label: "dev", baseUrl: "", funds: "play" },
    { label: "dev", baseUrl: "https://h.example.com" },
    { label: "dev", baseUrl: "https://h.example.com", funds: "play?" },
    { label: "dev", baseUrl: "https://u:p@h.example.com", funds: "play" },
  ];
  for (const descriptor of bad) {
    assert.throws(
      () =>
        new Client({
          network: descriptor as never,
          fetchImpl: NEVER_CALLED,
        }),
      NexusExchangeError,
      `expected ${JSON.stringify(descriptor)} to be refused`,
    );
  }

  // A valid literal is accepted, normalized and frozen — equivalent to having
  // gone through customNetwork().
  const client = new Client({
    network: {
      label: " dev ",
      baseUrl: "https://exchange.example.com/api/v1/",
      funds: "play",
      faucet: true,
      wsUrl: null,
      signingDomain: { name: "x", version: "y", chainId: 5 },
    } as never,
    fetchImpl: NEVER_CALLED,
  });
  assert.equal(client.label, "dev");
  assert.equal(client.baseUrl, "https://exchange.example.com/api/v1");
  assert.equal(client.hasFaucet, true);
  // name/version are not caller-supplied, so the literal's are ignored rather
  // than signed under.
  assert.equal(client.signingDomain.name, "Nexus Exchange");
  assert.equal(client.signingDomain.version, "1");
  assert.equal(client.requireSigningChainId(), 5);
});

test("a network that is neither a member nor a descriptor is refused", () => {
  for (const network of [42, true, [], () => {}, Symbol("x")]) {
    assert.throws(
      () => new Client({ network: network as never, fetchImpl: NEVER_CALLED }),
      (err: unknown) => {
        assert.ok(err instanceof NexusExchangeError);
        return true;
      },
      `expected ${String(network)} to be refused`,
    );
  }
});

// ── Nothing private is published ─────────────────────────────────────────────

// The reason this feature exists: the caller supplies the host, so no deployment
// this SDK does not name appears in the package. A hostname allowlist or
// denylist here would put one back in.
test("the axis gains no entry and customNetwork hardcodes no host", () => {
  assert.deepEqual(Object.keys(NETWORKS), ["testnet", "mainnet", "local"]);
  assert.deepEqual(Object.values(Network), ["testnet", "mainnet", "local"]);
  // No `Custom` enum member: it would key into a map entry that cannot exist.
  assert.equal(
    (Network as unknown as Record<string, unknown>).Custom,
    undefined,
  );
  // A base URL is required, so there is no default host to fall back to.
  assert.throws(
    () =>
      customNetwork({ label: "dev", funds: "play" } as CustomNetworkOptions),
    /baseUrl must be a non-empty absolute/,
  );
});

// ── The resolver accepts a descriptor anywhere a Network goes ────────────────

test("networkConfig and baseUrlForNetwork accept a descriptor too", () => {
  const target = customNetwork(options());
  // Idempotent: re-resolving a descriptor this module built returns it as-is.
  assert.equal(networkConfig(target), target);
  assert.equal(
    baseUrlForNetwork(target),
    "https://exchange.example.com/api/v1",
  );
  // Still refuses an unrecognized identifier, and now points at the way out.
  assert.throws(
    () => networkConfig("dev" as Network),
    /unrecognized network.+customNetwork/s,
  );
  // The built-in entries keep working unchanged.
  assert.equal(networkConfig(Network.Testnet), NETWORKS[Network.Testnet]);
});
