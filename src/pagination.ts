/**
 * Cursor / time auto-paging for list endpoints.
 *
 * List endpoints accept a `limit` and return a page of results plus a cursor
 * pointing at the next page. Rather than make callers hold and re-submit that
 * cursor by hand, the SDK exposes a {@link Paginator} that drives the cursor for
 * you: ask it for the next {@link Page}, iterate every item with
 * {@link Paginator.all}, or consume it item-by-item with `for await (…)` — a
 * `Paginator` is itself an async-iterable (the idiomatic TS analog of the Rust
 * SDK's `into_stream`).
 *
 * The paginator is generic over how a single page is fetched, so the same
 * machinery serves both cursor-based and time-windowed endpoints: a
 * time-windowed endpoint simply encodes its next time bound into the
 * {@link Cursor} it returns. This mirrors the Rust SDK's
 * `rest::pagination::Paginator` API surface and semantics one-to-one.
 *
 * @example
 * ```ts
 * // A list endpoint method builds a `Paginator` from a callback that fetches
 * // one page for a given request. `Client` captures itself here and issues the
 * // actual HTTP call.
 * function listTrades(): Paginator<number> {
 *   return new Paginator(async (req) => {
 *     // ... GET /v1/trades?limit={req.limit}&cursor={req.cursor} ...
 *     return new Page([1, 2, 3], null);
 *   });
 * }
 *
 * // Collect everything:
 * const trades = await listTrades().pageSize(100).all();
 *
 * // Or stream item-by-item without materializing the whole result set:
 * for await (const trade of listTrades().pageSize(100)) {
 *   handle(trade);
 * }
 * ```
 */

/**
 * An opaque pagination cursor returned by a list endpoint.
 *
 * Cursors are produced by the server and must be passed back verbatim to fetch
 * the following page; their contents are an implementation detail. Time-windowed
 * endpoints surface their next time bound through this same type, so callers
 * never need to special-case the two pagination styles.
 *
 * A `Cursor` serializes to (and parses from) its raw string via
 * {@link Cursor.toString}, so a caller can persist one (e.g. to a database or
 * job state) and later resume from it via {@link Paginator.startingAfter}.
 */
export class Cursor {
  readonly #raw: string;

  /** Wrap a raw cursor string (e.g. one previously persisted to resume from). */
  constructor(raw: string) {
    this.#raw = raw;
  }

  /** The cursor as a string, for use as a query parameter. */
  toString(): string {
    return this.#raw;
  }

  /** JSON-serializes to the bare cursor string (`JSON.stringify(cursor)`). */
  toJSON(): string {
    return this.#raw;
  }

  /** Structural equality against another cursor. */
  equals(other: Cursor | null | undefined): boolean {
    return other instanceof Cursor && other.#raw === this.#raw;
  }
}

/**
 * Coerce a raw string, an existing {@link Cursor}, or `null`/`undefined` into a
 * `Cursor | null`. Lets callers pass either form to {@link Paginator.startingAfter}
 * and endpoint methods thread a raw string straight through.
 */
export function toCursor(
  value: Cursor | string | null | undefined,
): Cursor | null {
  if (value == null) return null;
  return value instanceof Cursor ? value : new Cursor(value);
}

/**
 * The parameters for fetching a single page.
 *
 * Passed to the callback given to the {@link Paginator} constructor; the endpoint
 * method translates it into query parameters on the underlying request. This
 * shape is expected to grow fields (e.g. time-window bounds or a sort
 * direction), so read fields by name rather than by position.
 */
export interface PageRequest {
  /** Cursor for the page to fetch, or `null` for the first page. */
  cursor: Cursor | null;
  /** Maximum number of items to return, if a page size was configured. */
  limit: number | null;
}

/**
 * A single page returned by a list endpoint. Build one with the constructor
 * rather than an object literal, so future fields (e.g. a total count) don't
 * break callers.
 */
export class Page<T> {
  /**
   * @param items The items in this page, in server order.
   * @param nextCursor Cursor for the next page, or `null` on the final page.
   */
  constructor(
    readonly items: readonly T[],
    readonly nextCursor: Cursor | null,
  ) {}

  /** Whether this is the last page (i.e. there is no next cursor). */
  isLast(): boolean {
    return this.nextCursor === null;
  }
}

/** Fetches one page for a {@link PageRequest}. Given to the {@link Paginator} ctor. */
export type FetchPage<T> = (req: PageRequest) => Promise<Page<T>>;

/**
 * An auto-paging iterator over a list endpoint.
 *
 * A `Paginator` holds the state needed to walk every page of a list endpoint,
 * advancing the cursor automatically. Drive it page-by-page with
 * {@link nextPage}, collect everything with {@link all}, or treat it as an
 * async-iterable of items — `for await (const item of paginator)`.
 *
 * Pages are fetched lazily: no request is issued until the first page is
 * requested, and each subsequent page is fetched only when the previous one has
 * been consumed.
 *
 * The builder methods ({@link pageSize}, {@link maxPages}, {@link startingAfter})
 * mutate and return `this` for chaining, matching the Rust SDK's builder
 * ergonomics. A `Paginator` is single-use: iterating or calling {@link all}
 * consumes it. To re-run a query, build a fresh `Paginator`.
 */
export class Paginator<T> implements AsyncIterable<T> {
  readonly #fetch: FetchPage<T>;
  #nextCursor: Cursor | null = null;
  #pageSize: number | null = null;
  #maxPages: number | null = null;
  #pagesFetched = 0;
  #done = false;

  /**
   * Build a paginator from a callback that fetches one page per request.
   *
   * The callback is called with a {@link PageRequest} carrying the cursor (and
   * configured page size) for the page to fetch, and returns that page along
   * with the cursor for the next one.
   */
  constructor(fetch: FetchPage<T>) {
    this.#fetch = fetch;
  }

  /**
   * Set the per-page `limit` requested from the endpoint.
   *
   * This bounds the size of each page, not the total number of items returned —
   * the paginator still walks every page.
   */
  pageSize(limit: number): this {
    this.#pageSize = limit;
    return this;
  }

  /**
   * Cap the number of pages this paginator will fetch.
   *
   * At most `max` pages (hence requests) are fetched; once that many have been
   * returned the paginator stops as if it had reached the final page, even if
   * the server is still handing back a next cursor. `maxPages(0)` fetches
   * nothing. This is a safety bound against a misbehaving backend that never
   * terminates; the repeated-cursor guard in {@link nextPage} already covers a
   * server that keeps echoing the *same* cursor, but `maxPages` also bounds one
   * that keeps advancing without end.
   */
  maxPages(max: number): this {
    this.#maxPages = max;
    return this;
  }

  /**
   * Resume paging from a previously obtained cursor.
   *
   * The next page fetched will be the one following `cursor`.
   */
  startingAfter(cursor: Cursor | string): this {
    this.#nextCursor = toCursor(cursor);
    return this;
  }

  /**
   * Fetch the next page, or `null` once every page has been returned.
   *
   * Advances the internal cursor so the following call fetches the page after
   * this one.
   *
   * Termination is guarded against a misbehaving backend: if the server returns
   * a next cursor equal to the one just requested — a stuck server, a time bound
   * that fails to advance, or a cursor that round-trips to the same window — the
   * paginator returns this page and then stops rather than re-issuing the
   * identical request forever. A {@link maxPages} cap, if set, bounds paging even
   * when the cursor keeps advancing.
   */
  async nextPage(): Promise<Page<T> | null> {
    // Checked before fetching so a `maxPages` cap issues *at most* that many
    // requests — `maxPages(0)` fetches nothing at all.
    if (this.#done || this.#maxPages === this.#pagesFetched) {
      return null;
    }

    const requested = this.#nextCursor;
    this.#nextCursor = null;
    const page = await this.#fetch({
      cursor: requested,
      limit: this.#pageSize,
    });
    this.#pagesFetched += 1;

    const next = page.nextCursor;
    if (next === null) {
      // Final page.
      this.#done = true;
    } else if (requested !== null && next.equals(requested)) {
      // Server handed back the same cursor it was given: refuse to spin.
      this.#done = true;
    } else {
      this.#nextCursor = next;
    }

    return page;
  }

  /**
   * Walk every remaining page and collect all items into a single array.
   *
   * Convenience for the common "give me everything" case. Prefer
   * {@link nextPage} or the async-iterator (`for await`) when the full result
   * set may be large.
   */
  async all(): Promise<T[]> {
    const out: T[] = [];
    for (
      let page = await this.nextPage();
      page !== null;
      page = await this.nextPage()
    ) {
      out.push(...page.items);
    }
    return out;
  }

  /**
   * Consume the paginator as an async-iterable yielding one item at a time —
   * the idiomatic TS analog of the Rust SDK's `into_stream`.
   *
   * Pages are fetched on demand as iteration proceeds; empty pages that still
   * carry a next cursor are skipped transparently. Iteration ends at the first
   * error (which propagates out of the `for await`). The iterator is single-use
   * and does not resume after an error — build a fresh paginator with
   * {@link startingAfter} from the last successfully returned page's cursor to
   * continue.
   */
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (
      let page = await this.nextPage();
      page !== null;
      page = await this.nextPage()
    ) {
      yield* page.items;
    }
  }
}
