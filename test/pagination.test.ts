import { test } from "node:test";
import assert from "node:assert/strict";

import { Cursor, Page, Paginator, toCursor } from "../src/pagination.js";
import type { PageRequest } from "../src/pagination.js";

/**
 * A fake endpoint that pages through `total` integers, `perPage` at a time,
 * using the item index as an opaque cursor. Returns the paginator and a `calls`
 * counter recording how many pages (round-trips) were fetched.
 */
function fakeEndpoint(total: number, perPage: number) {
  const calls = { count: 0 };
  const pager = new Paginator<number>(async (req: PageRequest) => {
    calls.count += 1;
    const start = req.cursor ? Number(req.cursor.toString()) : 0;
    const end = Math.min(start + perPage, total);
    const items: number[] = [];
    for (let i = start; i < end; i++) items.push(i);
    const next = end < total ? new Cursor(String(end)) : null;
    return new Page(items, next);
  });
  return { pager, calls };
}

test("nextPage walks every page then returns null", async () => {
  const { pager, calls } = fakeEndpoint(5, 2);

  const p1 = await pager.nextPage();
  assert.deepEqual(p1?.items, [0, 1]);
  assert.equal(p1?.isLast(), false);

  const p2 = await pager.nextPage();
  assert.deepEqual(p2?.items, [2, 3]);

  const p3 = await pager.nextPage();
  assert.deepEqual(p3?.items, [4]);
  assert.equal(p3?.isLast(), true);

  assert.equal(await pager.nextPage(), null);
  // No request is issued past the final page.
  assert.equal(await pager.nextPage(), null);
  assert.equal(calls.count, 3);
});

test("all() collects items in order", async () => {
  const { pager, calls } = fakeEndpoint(7, 3);
  assert.deepEqual(await pager.all(), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(calls.count, 3); // 3 + 3 + 1
});

test("for await yields every item", async () => {
  const { pager } = fakeEndpoint(5, 2);
  const collected: number[] = [];
  for await (const item of pager) collected.push(item);
  assert.deepEqual(collected, [0, 1, 2, 3, 4]);
});

test("pageSize is threaded into every request", async () => {
  let seen = 0;
  const pager = new Paginator<number>(async (req) => {
    assert.equal(req.limit, 50);
    seen += 1;
    return new Page([1], null);
  }).pageSize(50);
  await pager.all();
  assert.equal(seen, 1);
});

test("startingAfter resumes from a cursor (string or Cursor)", async () => {
  assert.deepEqual(
    await fakeEndpoint(5, 2).pager.startingAfter("2").all(),
    [2, 3, 4],
  );
  assert.deepEqual(
    await fakeEndpoint(5, 2).pager.startingAfter(new Cursor("2")).all(),
    [2, 3, 4],
  );
});

test("empty page with a cursor is skipped", async () => {
  const pager = new Paginator<number>(async (req) => {
    const c = req.cursor?.toString() ?? null;
    if (c === null) return new Page<number>([], new Cursor("next"));
    if (c === "next") return new Page([10, 11], null);
    throw new Error(`unexpected cursor: ${c}`);
  });
  assert.deepEqual(await pager.all(), [10, 11]);
});

test("errors propagate through nextPage and halt paging", async () => {
  let n = 0;
  const pager = new Paginator<number>(async () => {
    if (n++ === 0) return new Page([0], new Cursor("1"));
    throw new Error("kaboom");
  });
  const p1 = await pager.nextPage();
  assert.deepEqual(p1?.items, [0]);
  await assert.rejects(() => pager.nextPage(), /kaboom/);
});

test("errors propagate through all()", async () => {
  let n = 0;
  const pager = new Paginator<number>(async () => {
    if (n++ < 2) return new Page([n], new Cursor(String(n + 1)));
    throw new Error("kaboom");
  });
  await assert.rejects(() => pager.all(), /kaboom/);
});

test("errors propagate through for await", async () => {
  const pager = new Paginator<number>(async () => {
    throw new Error("kaboom");
  });
  await assert.rejects(async () => {
    for await (const _ of pager) void _;
  }, /kaboom/);
});

test("an empty final first page terminates immediately", async () => {
  let calls = 0;
  const make = () =>
    new Paginator<number>(async () => {
      calls += 1;
      return new Page<number>([], null);
    });

  assert.deepEqual(await make().all(), []);

  const collected: number[] = [];
  for await (const item of make()) collected.push(item);
  assert.deepEqual(collected, []);
  // One fetch per run — no spinning on the empty page.
  assert.equal(calls, 2);
});

test("a repeated cursor does not spin", async () => {
  let calls = 0;
  const pager = new Paginator<number>(async () => {
    calls += 1;
    return new Page([1], new Cursor("stuck"));
  }).startingAfter("stuck");

  const p1 = await pager.nextPage();
  assert.deepEqual(p1?.items, [1]);
  // The paginator refuses to re-issue the identical request.
  assert.equal(await pager.nextPage(), null);
  assert.equal(calls, 1);
});

test("all() terminates even when the server never stops paging", async () => {
  const pager = new Paginator<number>(async () => {
    // Same cursor every time, regardless of what was requested.
    return new Page([7], new Cursor("loop"));
  }).startingAfter("loop");
  assert.deepEqual(await pager.all(), [7]);
});

test("maxPages caps paging", async () => {
  const { pager, calls } = fakeEndpoint(100, 2);
  assert.deepEqual(await pager.maxPages(3).all(), [0, 1, 2, 3, 4, 5]);
  assert.equal(calls.count, 3);
});

test("maxPages(0) fetches nothing", async () => {
  const { pager, calls } = fakeEndpoint(100, 2);
  assert.deepEqual(await pager.maxPages(0).all(), []);
  // The cap is checked before fetching, so no request is ever issued.
  assert.equal(calls.count, 0);
});

test("builder methods chain and can be combined", async () => {
  let lastLimit: number | null = -1;
  const pager = new Paginator<number>(async (req) => {
    lastLimit = req.limit;
    const start = req.cursor ? Number(req.cursor.toString()) : 0;
    return new Page([start], new Cursor(String(start + 1)));
  })
    .pageSize(10)
    .maxPages(2)
    .startingAfter("5");
  assert.deepEqual(await pager.all(), [5, 6]);
  assert.equal(lastLimit, 10);
});

test("Cursor JSON round-trips to its bare string", () => {
  const cursor = new Cursor("opaque-token");
  const json = JSON.stringify(cursor);
  assert.equal(json, '"opaque-token"');
  assert.equal(JSON.parse(json), "opaque-token");
  assert.equal(cursor.toString(), "opaque-token");
});

test("Cursor equality is structural", () => {
  assert.equal(new Cursor("a").equals(new Cursor("a")), true);
  assert.equal(new Cursor("a").equals(new Cursor("b")), false);
  assert.equal(new Cursor("a").equals(null), false);
});

test("toCursor coerces strings, cursors, and nullish values", () => {
  assert.equal(toCursor(null), null);
  assert.equal(toCursor(undefined), null);
  assert.equal(toCursor("x")?.toString(), "x");
  const c = new Cursor("y");
  assert.equal(toCursor(c), c);
});
