// WebSocket client for the Nexus Exchange streaming API.
//
// What this is
// ------------
// A small, dependency-free multiplexing client over the exchange's `/ws`
// endpoint. It:
//
//   1. Opens a single WebSocket and fans any number of `subscribe(channel,
//      {market, since})` calls onto it.
//   2. Tracks the highest `seq` per (channel, market). On disconnect it
//      reconnects (with jittered exponential backoff), optionally mints a
//      fresh auth token, and re-subscribes from `lastSeq` so the server can
//      replay anything missed from its ring buffer.
//   3. Surfaces every subscription as an `AsyncIterable<WsEvent>` with
//      bounded buffering, and the connection state via `status()`.
//
// Channels
// --------
// Public market-data channels — `book`, `trades`, `candles` — need no auth.
// Account-scoped channels — `orders`, `fills`, `positions`, `balances` —
// require a short-lived token. The SDK does not know how your deployment
// mints tokens (the web app signs the mint request with an agent key); you
// supply that via `tokenProvider`. Subscribing to an account-scoped channel
// without a `tokenProvider` is an error, caught early.
//
// Concurrency / safety notes
// --------------------------
// JavaScript is single-threaded, so there are no lock-based deadlocks here.
// The two things that *can* go wrong in an async client like this are
// (a) stale socket callbacks from a previous connection racing the current
// one, and (b) unbounded memory growth when a consumer stops reading. Both
// are handled explicitly below — see `attachHandlers` (every handler is
// fenced behind `this.ws === ws`) and `deliverEvent` (bounded per-sub queue
// with drop-oldest + an `outOfSync` sentinel so the consumer knows to
// refetch). The async-iterator handshake never reorders events: a waiter is
// only ever registered while the queue is empty, so a newly delivered event
// either wakes that waiter or lands at the tail of an empty queue.

// ── Public types ─────────────────────────────────────────────────────────────

/** Public market-data channels. No authentication required. */
export type PublicChannel = "book" | "trades" | "candles";

/** Account-scoped channels. Require a `tokenProvider`. */
export type AccountChannel = "orders" | "fills" | "positions" | "balances";

export type Channel = PublicChannel | AccountChannel;

const PUBLIC_CHANNELS: ReadonlySet<Channel> = new Set<Channel>([
  "book",
  "trades",
  "candles",
]);
const ACCOUNT_CHANNELS: ReadonlySet<Channel> = new Set<Channel>([
  "orders",
  "fills",
  "positions",
  "balances",
]);
function isChannel(value: unknown): value is Channel {
  return (
    typeof value === "string" &&
    (PUBLIC_CHANNELS.has(value as Channel) ||
      ACCOUNT_CHANNELS.has(value as Channel))
  );
}

/** Connection state surfaced via `status()`. */
export type WsStatus = "connecting" | "open" | "reconnecting" | "closed";

/** A single event delivered to a subscription consumer. */
export interface WsEvent {
  channel: Channel;
  market?: string;
  /** Server-assigned monotonic sequence number per (channel, market). */
  seq: bigint;
  /**
   * Opaque event payload. `null` when `outOfSync` is true (the sentinel
   * carries no payload of its own).
   */
  data: unknown;
  /**
   * True when this is a synthetic notice — not a real engine event — telling
   * the consumer the stream lost continuity (server ring overran, or the
   * local buffer dropped events under backpressure). The consumer should do
   * a full REST refetch and rely on live events from here on.
   */
  outOfSync?: boolean;
}

export interface WsSubscription {
  events: AsyncIterable<WsEvent>;
  /** Tear down this subscription. Idempotent. */
  unsubscribe(): void;
}

export interface WsClient {
  subscribe(
    channel: Channel,
    opts?: { market?: string; since?: bigint },
  ): WsSubscription;
  /** Close the connection and end every subscription. Idempotent. */
  close(): void;
  status(): WsStatus;
}

/**
 * Mints a fresh, short-lived connection token. Called on every (re)connect.
 * Throwing (or returning an empty string) triggers a backed-off retry rather
 * than tearing the client down — the credential may be transiently
 * unavailable (e.g. mid-rotation).
 */
export type TokenProvider = () => Promise<string>;

/**
 * Minimal structural shape of a WebSocket. Matches the browser `WebSocket`,
 * Node's global `WebSocket`, and the `ws` package — so the SDK stays
 * isomorphic without pulling in the DOM lib.
 */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export interface WebSocketCtor {
  new (url: string): WebSocketLike;
  readonly OPEN: number;
}

export interface CreateWsClientOpts {
  /**
   * WebSocket base URL — `ws://` or `wss://`. The stream path (default
   * `/ws`) is appended. A token, when minted, is appended as `?token=…`.
   */
  url: string;
  /** Path appended to `url`. Defaults to `/ws`. */
  path?: string;
  /**
   * Supplies auth tokens for account-scoped channels. Omit for a
   * public-data-only client.
   */
  tokenProvider?: TokenProvider;
  /** WebSocket implementation. Defaults to the runtime global. */
  WebSocketImpl?: WebSocketCtor;
  /**
   * Max events buffered per subscription before the oldest are dropped and
   * an `outOfSync` sentinel is injected. Guards against unbounded memory
   * growth when a consumer stops reading. Default 1024.
   */
  maxQueueSize?: number;
  /** Base reconnect backoff in ms (before jitter). Default 250. */
  baseReconnectDelayMs?: number;
  /** Max reconnect backoff in ms. Default 10000. */
  maxReconnectDelayMs?: number;
}

// ── Wire shapes (server → client) ─────────────────────────────────────────────
//
// The server tags messages with `op` and otherwise uses snake_case field
// names. We validate defensively in `handleServerOp` rather than trusting
// these shapes — a malformed frame must never throw out of `onmessage`.

interface ServerEvent {
  op: "event";
  channel: string;
  market: string | null;
  seq: number | string;
  payload: unknown;
}
interface ServerOutOfSync {
  op: "out_of_sync";
  channel: string;
  market: string | null;
  /** Oldest seq still replayable, or null when the ring is empty. */
  oldest_seq: number | string | null;
}

// ── Subscription bookkeeping ──────────────────────────────────────────────────

interface Sub {
  key: string;
  channel: Channel;
  market?: string;
  /** Last seq delivered to the consumer for this (channel, market). */
  lastSeq: bigint;
  /** Original `since` from the consumer; used only on the first subscribe. */
  initialSince?: bigint;
  /** Bounded queue of events awaiting the AsyncIterable consumer. */
  queue: WsEvent[];
  /** Pending iterator-resume waiters (consumer awaiting `next()`). */
  waiters: Array<(value: IteratorResult<WsEvent>) => void>;
  closed: boolean;
}

function subKey(channel: Channel, market: string | undefined): string {
  return `${channel}|${market ?? ""}`;
}

/**
 * Coerce an untrusted wire value into a non-negative bigint seq, or null if
 * it isn't a valid one. Accepts JS numbers (must be safe non-negative
 * integers) and decimal strings (so u64 values past 2^53 survive intact).
 */
function toSeq(value: unknown): bigint | null {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) return null;
    return BigInt(value);
  }
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return BigInt(value);
  return null;
}

// ── Implementation ────────────────────────────────────────────────────────────

class WsClientImpl implements WsClient {
  private readonly base: string;
  private readonly path: string;
  private readonly tokenProvider?: TokenProvider;
  private readonly WebSocketCtor: WebSocketCtor;
  private readonly maxQueueSize: number;
  private readonly baseReconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;

  private ws: WebSocketLike | null = null;
  private state: WsStatus = "closed";
  private closing = false;
  /** Reentrancy guard: a `connect()` is between entry and socket creation. */
  private connecting = false;

  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly subs = new Map<string, Sub>();
  /** Subs whose `subscribe` op has been sent on the *current* socket. */
  private sentOnSocket = new Set<string>();

  constructor(opts: {
    base: string;
    path: string;
    tokenProvider?: TokenProvider;
    WebSocketCtor: WebSocketCtor;
    maxQueueSize: number;
    baseReconnectDelayMs: number;
    maxReconnectDelayMs: number;
  }) {
    this.base = opts.base;
    this.path = opts.path;
    this.tokenProvider = opts.tokenProvider;
    this.WebSocketCtor = opts.WebSocketCtor;
    this.maxQueueSize = opts.maxQueueSize;
    this.baseReconnectDelayMs = opts.baseReconnectDelayMs;
    this.maxReconnectDelayMs = opts.maxReconnectDelayMs;
  }

  status(): WsStatus {
    return this.state;
  }

  subscribe(
    channel: Channel,
    opts: { market?: string; since?: bigint } = {},
  ): WsSubscription {
    if (this.closing) {
      throw new Error("cannot subscribe on a closed WsClient");
    }
    if (!isChannel(channel)) {
      throw new Error(`unknown channel: ${String(channel)}`);
    }
    if (ACCOUNT_CHANNELS.has(channel) && !this.tokenProvider) {
      throw new Error(
        `channel "${channel}" is account-scoped and requires a tokenProvider`,
      );
    }
    if (opts.since !== undefined && opts.since < 0n) {
      throw new Error("since must be >= 0");
    }

    const key = subKey(channel, opts.market);
    // One sub per (channel, market). A second subscribe replaces the first
    // (and ends its iterable) so the server never double-broadcasts to us.
    const existing = this.subs.get(key);
    if (existing) this.teardownSub(existing);

    const sub: Sub = {
      key,
      channel,
      market: opts.market,
      lastSeq: 0n,
      initialSince: opts.since,
      queue: [],
      waiters: [],
      closed: false,
    };
    this.subs.set(key, sub);

    if (this.state === "closed" && !this.connecting) {
      void this.connect();
    } else if (this.ws && this.ws.readyState === this.WebSocketCtor.OPEN) {
      this.sendSubscribe(sub);
    }

    return {
      events: this.iterateSub(sub),
      unsubscribe: () => this.teardownSub(sub),
    };
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    for (const sub of [...this.subs.values()]) this.teardownSub(sub);
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.dropSocket();
    this.state = "closed";
  }

  // ── Connection lifecycle ────────────────────────────────────────────────────

  private async connect(): Promise<void> {
    // `connecting` fences the async window before the socket is assigned;
    // `this.ws` fences after. Together they guarantee at most one live socket.
    if (this.closing || this.connecting || this.ws) return;
    this.connecting = true;
    this.state = this.reconnectAttempts > 0 ? "reconnecting" : "connecting";
    try {
      let token: string | undefined;
      if (this.tokenProvider) {
        try {
          token = await this.tokenProvider();
        } catch {
          if (!this.closing) this.scheduleReconnect();
          return;
        }
        if (!token) {
          if (!this.closing) this.scheduleReconnect();
          return;
        }
      }
      // The async mint above is a window in which the client may have been
      // closed or every subscription torn down. Don't open an orphan socket.
      if (this.closing || this.subs.size === 0) {
        if (this.subs.size === 0) this.state = "closed";
        return;
      }

      let ws: WebSocketLike;
      try {
        ws = new this.WebSocketCtor(this.buildUrl(token));
      } catch {
        this.scheduleReconnect();
        return;
      }
      this.ws = ws;
      this.sentOnSocket.clear();
      this.attachHandlers(ws);
    } finally {
      this.connecting = false;
    }
  }

  private buildUrl(token: string | undefined): string {
    const endpoint = `${this.base}${this.path}`;
    if (!token) return endpoint;
    const sep = endpoint.includes("?") ? "&" : "?";
    return `${endpoint}${sep}token=${encodeURIComponent(token)}`;
  }

  private attachHandlers(ws: WebSocketLike): void {
    // Every handler is fenced behind `this.ws === ws`: a callback from a
    // socket we've already replaced (a stale close firing after we built the
    // next connection) must do nothing, or it would spawn a duplicate
    // reconnect loop.
    ws.onopen = () => {
      if (this.ws !== ws) {
        this.safeClose(ws);
        return;
      }
      if (this.closing) {
        this.safeClose(ws);
        return;
      }
      this.state = "open";
      this.reconnectAttempts = 0;
      for (const sub of this.subs.values()) this.sendSubscribe(sub);
    };

    ws.onmessage = (ev: { data: unknown }) => {
      if (this.ws !== ws) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return; // non-JSON / binary frame — ignore
      }
      try {
        this.handleServerOp(parsed);
      } catch {
        // A malformed-but-parseable frame must never crash the client.
      }
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.detach(ws);
      this.ws = null;
      if (this.closing) {
        this.state = "closed";
        return;
      }
      this.state = "reconnecting";
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      if (this.ws !== ws) return;
      // Per the WHATWG spec, `onclose` follows `onerror`; we just ensure the
      // socket actually closes so the reconnect path runs.
      this.safeClose(ws);
    };
  }

  private scheduleReconnect(): void {
    if (this.closing) return;
    if (this.subs.size === 0) {
      this.state = "closed";
      return;
    }
    this.reconnectAttempts += 1;
    const ceiling = Math.min(
      this.maxReconnectDelayMs,
      this.baseReconnectDelayMs * 2 ** (this.reconnectAttempts - 1),
    );
    // Equal jitter: half fixed, half random. Bounds the delay to
    // [ceiling/2, ceiling] so it's never zero (no busy-loop) yet spreads
    // reconnects across clients to avoid a thundering herd on the server.
    const delay = ceiling / 2 + Math.random() * (ceiling / 2);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private sendSubscribe(sub: Sub): void {
    if (!this.ws || this.ws.readyState !== this.WebSocketCtor.OPEN) return;
    if (this.sentOnSocket.has(sub.key)) return;
    // On reconnect, ask the server to replay from `lastSeq`. On a first-ever
    // subscribe use the consumer's `since` if given, else live-from-now.
    const since =
      sub.lastSeq > 0n ? sub.lastSeq : (sub.initialSince ?? undefined);
    const msg: {
      op: "subscribe";
      channel: string;
      market?: string;
      since?: number;
    } = { op: "subscribe", channel: sub.channel };
    if (sub.market !== undefined) msg.market = sub.market;
    if (since !== undefined && since <= BigInt(Number.MAX_SAFE_INTEGER)) {
      msg.since = Number(since);
    }
    try {
      this.ws.send(JSON.stringify(msg));
      this.sentOnSocket.add(sub.key);
    } catch {
      // Lost a race with close — `onclose` drives the reconnect.
    }
  }

  private sendUnsubscribe(sub: Sub): void {
    if (!this.ws || this.ws.readyState !== this.WebSocketCtor.OPEN) return;
    const msg: { op: "unsubscribe"; channel: string; market?: string } = {
      op: "unsubscribe",
      channel: sub.channel,
    };
    if (sub.market !== undefined) msg.market = sub.market;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      // ignore — we're tearing this sub down regardless
    }
  }

  private handleServerOp(op: unknown): void {
    if (!op || typeof op !== "object") return;
    const tag = (op as { op?: unknown }).op;
    if (tag === "event") {
      const e = op as ServerEvent;
      const channel = e.channel;
      if (!isChannel(channel)) return;
      const market = typeof e.market === "string" ? e.market : undefined;
      const seq = toSeq(e.seq);
      if (seq === null) return;
      const sub = this.subs.get(subKey(channel, market));
      if (!sub || sub.closed) return;
      // Drop duplicates / out-of-order seqs (e.g. a replay overlapping events
      // we already delivered before a reconnect).
      if (seq <= sub.lastSeq) return;
      sub.lastSeq = seq;
      this.deliverEvent(sub, { channel, market, seq, data: e.payload });
      return;
    }
    if (tag === "out_of_sync") {
      const e = op as ServerOutOfSync;
      const channel = e.channel;
      if (!isChannel(channel)) return;
      const market = typeof e.market === "string" ? e.market : undefined;
      const sub = this.subs.get(subKey(channel, market));
      if (!sub || sub.closed) return;
      // Reset our cursor to the server's oldest replayable seq so the next
      // subscribe asks for the right window. null => ring empty: reset to 0
      // (next subscribe is live-from-now) and let the consumer REST-refetch.
      sub.lastSeq = e.oldest_seq == null ? 0n : (toSeq(e.oldest_seq) ?? 0n);
      this.deliverEvent(sub, {
        channel,
        market,
        seq: sub.lastSeq,
        data: null,
        outOfSync: true,
      });
      return;
    }
    // `subscribed` / `unsubscribed` / `error` / unknown: nothing to route.
  }

  private deliverEvent(sub: Sub, evt: WsEvent): void {
    if (sub.closed) return;
    const waiter = sub.waiters.shift();
    if (waiter) {
      waiter({ value: evt, done: false });
      return;
    }
    sub.queue.push(evt);
    if (sub.queue.length > this.maxQueueSize) {
      // Slow/absent consumer. Keep the newest events, drop the oldest, and
      // leave a single `outOfSync` sentinel at the tail so the consumer knows
      // it lost continuity and must refetch. Total stays bounded.
      const sentinel: WsEvent = {
        channel: sub.channel,
        market: sub.market,
        seq: sub.lastSeq,
        data: null,
        outOfSync: true,
      };
      sub.queue = sub.queue.slice(sub.queue.length - (this.maxQueueSize - 1));
      sub.queue.push(sentinel);
    }
  }

  private async *iterateSub(sub: Sub): AsyncGenerator<WsEvent> {
    try {
      while (true) {
        if (sub.queue.length > 0) {
          yield sub.queue.shift()!;
          continue;
        }
        if (sub.closed) return;
        const next = await new Promise<IteratorResult<WsEvent>>((resolve) => {
          sub.waiters.push(resolve);
        });
        if (next.done) return;
        yield next.value;
      }
    } finally {
      // The consumer abandoned the iterator (break / return / throw). Tear the
      // sub down so we stop buffering for a reader that's gone. Idempotent.
      this.teardownSub(sub);
    }
  }

  private teardownSub(sub: Sub): void {
    if (sub.closed) return;
    sub.closed = true;
    this.sentOnSocket.delete(sub.key);
    // Only forget the map entry if it still points at *this* sub — a
    // replacing subscribe may have already installed a new one under the key.
    if (this.subs.get(sub.key) === sub) this.subs.delete(sub.key);
    this.sendUnsubscribe(sub);
    // Wake any parked `next()` with done.
    while (sub.waiters.length > 0) {
      const w = sub.waiters.shift()!;
      w({ value: undefined, done: true });
    }
    sub.queue = [];
    if (this.subs.size === 0 && !this.closing) {
      // Nothing left to keep the socket open for.
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.dropSocket();
      this.state = "closed";
    }
  }

  private dropSocket(): void {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    this.detach(ws);
    this.safeClose(ws);
  }

  private detach(ws: WebSocketLike): void {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
  }

  private safeClose(ws: WebSocketLike): void {
    try {
      ws.close();
    } catch {
      // ignore
    }
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

function resolveWebSocketCtor(
  override: WebSocketCtor | undefined,
): WebSocketCtor {
  if (override) return override;
  const g = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
  if (!g) {
    throw new Error(
      "no WebSocket implementation available — pass `WebSocketImpl` (e.g. the `ws` package on Node < 22)",
    );
  }
  return g;
}

function isLocalHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost")
  );
}

/**
 * Create a multiplexing WebSocket client for the Nexus Exchange streaming API.
 *
 * Each call returns an independent client owning one socket. Share the
 * returned instance across your app rather than calling this repeatedly for
 * the same endpoint.
 */
export function createWsClient(opts: CreateWsClientOpts): WsClient {
  let parsed: URL;
  try {
    parsed = new URL(opts.url);
  } catch {
    throw new Error(`invalid WebSocket url: ${opts.url}`);
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(
      `WebSocket url must use ws:// or wss://, got ${parsed.protocol}`,
    );
  }
  // Refuse to send an auth token in cleartext to a remote host. Plain ws://
  // is only tolerated for loopback (local dev). This is the difference
  // between a leaked credential and a non-issue.
  if (
    opts.tokenProvider &&
    parsed.protocol === "ws:" &&
    !isLocalHost(parsed.hostname)
  ) {
    throw new Error(
      `refusing to mint auth tokens over insecure ws:// to ${parsed.hostname}; use wss://`,
    );
  }

  const path = opts.path ?? "/ws";
  // Strip any trailing slash on the base so `base + path` never doubles up.
  const base = opts.url.replace(/\/+$/, "");

  const maxQueueSize = opts.maxQueueSize ?? 1024;
  if (!Number.isInteger(maxQueueSize) || maxQueueSize < 1) {
    throw new Error("maxQueueSize must be a positive integer");
  }

  return new WsClientImpl({
    base,
    path,
    tokenProvider: opts.tokenProvider,
    WebSocketCtor: resolveWebSocketCtor(opts.WebSocketImpl),
    maxQueueSize,
    baseReconnectDelayMs: opts.baseReconnectDelayMs ?? 250,
    maxReconnectDelayMs: opts.maxReconnectDelayMs ?? 10_000,
  });
}
