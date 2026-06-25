import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createWsClient,
  type WsEvent,
  type WebSocketCtor,
} from "../src/index.ts";

// ── Fake WebSocket harness ───────────────────────────────────────────────────

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = 0; // CONNECTING
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  url: string;
  sent: any[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  // Test controls -------------------------------------------------------------
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(undefined);
  }
  emit(payload: unknown) {
    const data =
      typeof payload === "string" ? payload : JSON.stringify(payload);
    this.onmessage?.({ data });
  }
  serverClose() {
    this.readyState = 3;
    this.onclose?.(undefined);
  }

  // WebSocketLike -------------------------------------------------------------
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.(undefined);
  }
  send(data: string) {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("send on non-open socket");
    }
    this.sent.push(JSON.parse(data));
  }
}

const Ctor = FakeWebSocket as unknown as WebSocketCtor;

function reset() {
  FakeWebSocket.instances = [];
}

let tokenCounter = 0;
function makeTokenProvider() {
  tokenCounter = 0;
  return async () => {
    tokenCounter += 1;
    return `tok-${tokenCounter}`;
  };
}

async function tick(ms = 5) {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitForSocket(n = 1, timeoutMs = 1500): Promise<FakeWebSocket> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (FakeWebSocket.instances.length >= n) {
      return FakeWebSocket.instances[n - 1];
    }
    await tick(5);
  }
  throw new Error(`waitForSocket: timed out waiting for instance ${n}`);
}

async function nextEvent(
  iter: AsyncIterator<WsEvent>,
  timeoutMs = 200,
): Promise<WsEvent | "timeout"> {
  const winner = await Promise.race([
    iter.next().then((r) => ({ kind: "value" as const, r })),
    new Promise<{ kind: "timeout" }>((res) =>
      setTimeout(() => res({ kind: "timeout" }), timeoutMs),
    ),
  ]);
  if (winner.kind === "timeout" || winner.r.done) return "timeout";
  return winner.r.value;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("mints a token and opens WS at /ws?token=…", async () => {
  reset();
  const client = createWsClient({
    url: "wss://test",
    tokenProvider: makeTokenProvider(),
    WebSocketImpl: Ctor,
  });
  client.subscribe("orders");

  const ws = await waitForSocket();
  assert.equal(ws.url, "wss://test/ws?token=tok-1");

  ws.open();
  await tick();
  assert.equal(ws.sent.length, 1);
  assert.deepEqual(
    { op: ws.sent[0].op, channel: ws.sent[0].channel },
    { op: "subscribe", channel: "orders" },
  );
  client.close();
});

test("public channels need no token (no ?token= in url)", async () => {
  reset();
  const client = createWsClient({ url: "ws://test", WebSocketImpl: Ctor });
  client.subscribe("book", { market: "BTC-PERP" });

  const ws = await waitForSocket();
  assert.equal(ws.url, "ws://test/ws");
  ws.open();
  await tick();
  assert.deepEqual(ws.sent[0], {
    op: "subscribe",
    channel: "book",
    market: "BTC-PERP",
  });
  client.close();
});

test("account-scoped channel without a tokenProvider throws", () => {
  reset();
  const client = createWsClient({ url: "ws://test", WebSocketImpl: Ctor });
  assert.throws(() => client.subscribe("orders"), /account-scoped/);
  client.close();
});

test("refuses to mint tokens over insecure ws:// to a remote host", () => {
  assert.throws(
    () =>
      createWsClient({
        url: "ws://example.com:9090",
        tokenProvider: makeTokenProvider(),
        WebSocketImpl: Ctor,
      }),
    /insecure ws:\/\//,
  );
});

test("delivers events with monotonic seq as bigint", async () => {
  reset();
  const client = createWsClient({
    url: "wss://test",
    tokenProvider: makeTokenProvider(),
    WebSocketImpl: Ctor,
  });
  const sub = client.subscribe("orders");
  const iter = sub.events[Symbol.asyncIterator]();

  const ws = await waitForSocket();
  ws.open();
  await tick();

  ws.emit({
    op: "event",
    channel: "orders",
    market: null,
    seq: 1,
    payload: { id: "o1" },
  });
  ws.emit({
    op: "event",
    channel: "orders",
    market: null,
    seq: 2,
    payload: { id: "o2" },
  });

  const a = await nextEvent(iter);
  const b = await nextEvent(iter);
  assert.ok(a !== "timeout" && a.seq === 1n && (a.data as any).id === "o1");
  assert.ok(b !== "timeout" && b.seq === 2n && (b.data as any).id === "o2");
  client.close();
});

test("two subscriptions share one socket and route by channel", async () => {
  reset();
  const client = createWsClient({
    url: "wss://test",
    tokenProvider: makeTokenProvider(),
    WebSocketImpl: Ctor,
  });
  const orders = client.subscribe("orders");
  const fills = client.subscribe("fills");
  const oIter = orders.events[Symbol.asyncIterator]();
  const fIter = fills.events[Symbol.asyncIterator]();

  const ws = await waitForSocket();
  ws.open();
  await tick();
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.deepEqual(ws.sent.map((m) => m.channel).sort(), ["fills", "orders"]);

  ws.emit({
    op: "event",
    channel: "fills",
    market: null,
    seq: 1,
    payload: { f: 1 },
  });
  ws.emit({
    op: "event",
    channel: "orders",
    market: null,
    seq: 1,
    payload: { o: 1 },
  });

  const f = await nextEvent(fIter);
  const o = await nextEvent(oIter);
  assert.ok(f !== "timeout" && f.channel === "fills");
  assert.ok(o !== "timeout" && o.channel === "orders");
  client.close();
});

test("reconnects with a fresh token and since=lastSeq", async () => {
  reset();
  const client = createWsClient({
    url: "wss://test",
    tokenProvider: makeTokenProvider(),
    WebSocketImpl: Ctor,
    baseReconnectDelayMs: 50,
  });
  client.subscribe("orders");

  const ws1 = await waitForSocket();
  assert.equal(ws1.url, "wss://test/ws?token=tok-1");
  ws1.open();
  await tick();
  assert.equal(ws1.sent[0].since, undefined); // no since on first subscribe

  ws1.emit({
    op: "event",
    channel: "orders",
    market: null,
    seq: 1,
    payload: {},
  });
  ws1.emit({
    op: "event",
    channel: "orders",
    market: null,
    seq: 7,
    payload: {},
  });
  ws1.serverClose();

  const ws2 = await waitForSocket(2);
  assert.equal(ws2.url, "wss://test/ws?token=tok-2");
  ws2.open();
  await tick();
  assert.deepEqual(ws2.sent[0], {
    op: "subscribe",
    channel: "orders",
    since: 7,
  });
  client.close();
});

test("out_of_sync yields a synthetic outOfSync sentinel", async () => {
  reset();
  const client = createWsClient({
    url: "wss://test",
    tokenProvider: makeTokenProvider(),
    WebSocketImpl: Ctor,
  });
  const sub = client.subscribe("orders");
  const iter = sub.events[Symbol.asyncIterator]();

  const ws = await waitForSocket();
  ws.open();
  await tick();
  ws.emit({
    op: "out_of_sync",
    channel: "orders",
    market: null,
    oldest_seq: 1234,
  });

  const evt = await nextEvent(iter);
  assert.ok(evt !== "timeout");
  if (evt === "timeout") return;
  assert.equal(evt.outOfSync, true);
  assert.equal(evt.channel, "orders");
  assert.equal(evt.seq, 1234n);
  assert.equal(evt.data, null);
  client.close();
});

test("ignores malformed frames without crashing", async () => {
  reset();
  const client = createWsClient({
    url: "wss://test",
    tokenProvider: makeTokenProvider(),
    WebSocketImpl: Ctor,
  });
  const sub = client.subscribe("orders");
  const iter = sub.events[Symbol.asyncIterator]();

  const ws = await waitForSocket();
  ws.open();
  await tick();

  ws.emit("not json at all");
  ws.emit({
    op: "event",
    channel: "orders",
    market: null,
    seq: 1.5,
    payload: {},
  }); // bad seq
  ws.emit({ op: "event", channel: "wat", market: null, seq: 1, payload: {} }); // bad channel
  ws.emit({ op: "totally-unknown" });
  ws.emit({
    op: "event",
    channel: "orders",
    market: null,
    seq: 5,
    payload: { ok: true },
  }); // good

  const evt = await nextEvent(iter);
  assert.ok(
    evt !== "timeout" && evt.seq === 5n && (evt.data as any).ok === true,
  );
  client.close();
});

test("bounds the per-sub queue and signals loss with outOfSync", async () => {
  reset();
  const client = createWsClient({
    url: "wss://test",
    tokenProvider: makeTokenProvider(),
    WebSocketImpl: Ctor,
    maxQueueSize: 4,
  });
  const sub = client.subscribe("trades");
  const iter = sub.events[Symbol.asyncIterator]();

  const ws = await waitForSocket();
  ws.open();
  await tick();

  // Flood far past the cap without reading.
  for (let i = 1; i <= 100; i++) {
    ws.emit({
      op: "event",
      channel: "trades",
      market: null,
      seq: i,
      payload: { i },
    });
  }

  // Drain whatever is buffered; it must be bounded and include an outOfSync.
  const drained: WsEvent[] = [];
  for (let i = 0; i < 10; i++) {
    const e = await nextEvent(iter, 50);
    if (e === "timeout") break;
    drained.push(e);
  }
  assert.ok(
    drained.length <= 4,
    `expected <= 4 buffered, got ${drained.length}`,
  );
  assert.ok(
    drained.some((e) => e.outOfSync === true),
    "expected an outOfSync sentinel",
  );
  // The newest event must be preserved.
  assert.ok(drained.some((e) => e.seq === 100n));
  client.close();
});

test("unsubscribe sends an unsubscribe op and closes the last socket", async () => {
  reset();
  const client = createWsClient({
    url: "wss://test",
    tokenProvider: makeTokenProvider(),
    WebSocketImpl: Ctor,
  });
  const sub = client.subscribe("orders");

  const ws = await waitForSocket();
  ws.open();
  await tick();

  sub.unsubscribe();
  assert.ok(
    ws.sent.some((m) => m.op === "unsubscribe" && m.channel === "orders"),
  );
  assert.equal(ws.readyState, 3); // socket torn down — no subs left
  assert.equal(client.status(), "closed");

  sub.unsubscribe(); // idempotent
  client.close();
});
