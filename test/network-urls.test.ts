import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Client, Network, NETWORKS, customNetwork } from "../src/client.js";
import { createWsClient, type WebSocketCtor } from "../src/index.ts";

// The resolved WebSocket URLs per network (ENG-17132). The public hosts route
// no WebSocket path at their root (`wss://<host>/stream` is a 404); the spec
// publishes the streams under `/v1`, the same prefix as its REST base.

const EXPECTED: Record<Network, { ws: string; stream: string; auth: string }> =
  {
    [Network.Testnet]: {
      ws: "wss://api.testnet.nexus.xyz/v1",
      stream: "wss://api.testnet.nexus.xyz/v1/stream",
      auth: "wss://api.testnet.nexus.xyz/v1/ws",
    },
    // Same shape; the host has no DNS record yet (ENG-15183).
    [Network.Mainnet]: {
      ws: "wss://api.nexus.xyz/v1",
      stream: "wss://api.nexus.xyz/v1/stream",
      auth: "wss://api.nexus.xyz/v1/ws",
    },
    [Network.Local]: {
      ws: "ws://localhost:9090",
      stream: "ws://localhost:9090/stream",
      auth: "ws://localhost:9090/ws",
    },
  };

/** Opens a socket through createWsClient and returns the URL it dialled. */
async function dialledUrl(url: string, path?: string): Promise<string> {
  const urls: string[] = [];
  class Fake {
    static OPEN = 1;
    readyState = 0;
    onopen = null;
    onclose = null;
    onerror = null;
    onmessage = null;
    constructor(u: string) {
      urls.push(u);
    }
    send() {}
    close() {}
  }
  const client = createWsClient({
    url,
    path,
    WebSocketImpl: Fake as unknown as WebSocketCtor,
  });
  client.subscribe("book", { market: "BTC-PERP" });
  const start = Date.now();
  while (urls.length === 0 && Date.now() - start < 1500) {
    await new Promise((r) => setTimeout(r, 5));
  }
  client.close();
  assert.equal(urls.length, 1, "createWsClient never opened a socket");
  return urls[0];
}

test("each network resolves the WS base, /stream and /ws URLs", async () => {
  for (const network of Object.values(Network)) {
    const want = EXPECTED[network];
    assert.equal(NETWORKS[network].wsUrl, want.ws, `${network} wsUrl`);
    assert.equal(await dialledUrl(want.ws, "/stream"), want.stream);
    assert.equal(await dialledUrl(want.ws), want.auth);
    // No double slash from a trailing one, and no doubled prefix.
    assert.equal(await dialledUrl(`${want.ws}/`, "/stream"), want.stream);
    assert.doesNotMatch(want.stream.slice("wss://".length), /\/\//);
    assert.doesNotMatch(want.auth, /\/v1\/v1/);
  }
});

test("a testnet client dials the /v1 streams", async () => {
  const client = new Client({ fetchImpl: async () => new Response("{}") });
  assert.equal(client.wsUrl, "wss://api.testnet.nexus.xyz/v1");
  assert.equal(
    await dialledUrl(client.wsUrl, "/stream"),
    "wss://api.testnet.nexus.xyz/v1/stream",
  );
  assert.equal(
    await dialledUrl(client.wsUrl),
    "wss://api.testnet.nexus.xyz/v1/ws",
  );
});

// The rule the spec enforces: the socket URL is the REST base with the scheme
// swapped, because `/ws/token` binds a token to the host that minted it. The
// REST base here is the vendored spec's `x-nexus-networks` `rest_base`. This
// SDK's own testnet `baseUrl` still carries `/indexer` (see NETWORKS), so it is
// held to the same host rather than the same string.
test("each network's wsUrl is the spec's REST base, scheme-swapped", () => {
  const spec = JSON.parse(
    readFileSync(new URL("../spec/openapi.json", import.meta.url), "utf8"),
  ) as {
    "x-nexus-networks": {
      networks: Record<string, { rest_base: string }>;
    };
  };
  const published = spec["x-nexus-networks"].networks;
  for (const network of Object.values(Network)) {
    const restBase = published[network]?.rest_base;
    assert.ok(restBase, `spec has no rest_base for ${network}`);
    assert.equal(
      NETWORKS[network].wsUrl,
      restBase.replace(/^http/, "ws").replace(/\/+$/, ""),
      `${network}: wsUrl is not ${restBase} scheme-swapped`,
    );
    const sdkBase = NETWORKS[network].baseUrl;
    if (sdkBase !== null) {
      assert.equal(
        new URL(NETWORKS[network].wsUrl!).host,
        new URL(sdkBase).host,
      );
    }
  }
});

test("mainnet declares its /v1 WS base but still refuses to construct", () => {
  assert.equal(NETWORKS[Network.Mainnet].baseUrl, null);
  assert.throws(() => new Client({ network: Network.Mainnet }));
});

test("caller overrides still win over the map", () => {
  const declared = new Client({
    network: customNetwork({
      label: "dev",
      baseUrl: "https://dev.example.invalid/indexer",
      funds: "play",
      wsUrl: "wss://stream.example.invalid/v1",
    }),
    fetchImpl: async () => new Response("{}"),
  });
  assert.equal(declared.wsUrl, "wss://stream.example.invalid/v1");

  const derived = new Client({
    network: customNetwork({
      label: "dev",
      baseUrl: "https://dev.example.invalid/v1",
      funds: "play",
    }),
    fetchImpl: async () => new Response("{}"),
  });
  assert.equal(derived.wsUrl, "wss://dev.example.invalid/v1");

  const bare = new Client({
    baseUrl: "https://other.example.invalid/indexer",
    fetchImpl: async () => new Response("{}"),
  });
  assert.equal(bare.wsUrl, "wss://other.example.invalid");
});
