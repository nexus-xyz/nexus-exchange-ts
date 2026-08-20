// Self-test for the operations half of the drift check (invariants F/G/H).
//
// `operationsDrift` documents itself as pure "so the self-test can defeat each
// invariant in isolation" — and until ENG-11847 there was no self-test, because
// an unconditional `main()` at the bottom of the script made the module
// unimportable. That sentence is now backed by this file.
//
// The standard: every test must go RED when the thing it checks is defeated. A
// test that only shows the checker passing on the good state cannot tell
// "verified" from "not looking".
import assert from "node:assert/strict";
import { test } from "node:test";

// @ts-expect-error — a .mjs script with no type declarations; this is a script
// under test, not a typed module of the package.
import { canonicalOp, operationsDrift } from "../scripts/check-spec-drift.mjs";

const BASE = "/api/v1";
const line = (op: string, n = 1) => ({ op, line: n });

/** Two operations, each declared under both spellings: 4 paths, 2 operations. */
const SPEC = new Set([
  "GET /orders",
  "GET /api/v1/orders",
  "GET /widgets",
  "GET /api/v1/widgets",
]);

// The two allowlists are emptied for every synthetic scenario. Left at their
// real defaults they are checked against these fixtures and report their own
// entries as stale — a finding about the real client, not about the fixture.
function run(opts: Record<string, unknown> = {}) {
  return operationsDrift({
    specOps: SPEC,
    targeted: [line("GET /api/v1/orders")],
    uncovered: [line("GET /orders"), line("GET /widgets"), line("GET /api/v1/widgets")],
    implemented: new Set(["GET /api/v1/orders"]),
    basePath: BASE,
    codeOnly: new Set(),
    nonRest: new Set(),
    ...opts,
  });
}

test("coverage counts operations, not documented paths", () => {
  const { summary } = run();
  // 1 of 2 — NOT 1 of 4. The old summary divided by the path count.
  assert.match(summary, /covers 1 of 2 spec operation\(s\) \(50\.0%\)/);
  assert.match(summary, /4 documented paths, 2 of them a second spelling/);
});

test("the twin count separates 'other spelling' from a real gap", () => {
  const { summary } = run();
  // 3 lines in uncovered-ops.txt, exactly 1 of which is the twin of a targeted op.
  assert.match(summary, /3 lines in spec\/uncovered-ops\.txt, 1 of them the twin/);
  // And 1 operation genuinely not targeted (GET /widgets), not 3.
  assert.match(summary, /1 operation\(s\) not targeted/);
});

test("both spellings of an operation canonicalize to the same id", () => {
  assert.equal(
    canonicalOp("GET /api/v1/orders", BASE),
    canonicalOp("GET /orders", BASE),
  );
  assert.equal(canonicalOp("GET /orders", BASE), "GET /orders");
});

test("the prefix is stripped only as a whole segment", () => {
  // Asserted on the resulting op ID, not on counts. `/api/v1foo` is not the
  // prefix followed by a path, and stripping a partial match yields `foo` — an
  // operation the spec never declared. Every count in the summary comes out
  // identical either way, so a count-only assertion passes straight over it;
  // this is the mutation that survived the first version of these tests.
  for (const path of ["/api/v1foo", "/api/v1", "/apiv1/orders", "/v1/orders"]) {
    assert.equal(canonicalOp(`GET ${path}`, BASE), `GET ${path}`, path);
  }
});

test("the method is part of the identity", () => {
  // Collapsing on path alone would merge GET and POST on one route into a
  // single "covered" operation.
  assert.notEqual(
    canonicalOp("GET /api/v1/orders", BASE),
    canonicalOp("POST /orders", BASE),
  );
});

test("a partial-prefix path stays out of the canonical set", () => {
  const { summary } = operationsDrift({
    specOps: new Set(["GET /api/v1foo", "GET /api/v1/orders", "GET /orders"]),
    targeted: [line("GET /api/v1/orders")],
    uncovered: [line("GET /api/v1foo"), line("GET /orders")],
    implemented: new Set(["GET /api/v1/orders"]),
    basePath: BASE,
    codeOnly: new Set(),
    nonRest: new Set(),
  });
  // 3 paths -> 2 operations (/orders and /api/v1foo), so exactly 1 spelling collapsed.
  assert.match(summary, /covers 1 of 2 spec operation\(s\)/);
  assert.match(summary, /3 documented paths, 1 of them a second spelling/);
});

test("a trailing slash on API_BASE_PATH does not break canonicalization", () => {
  // basePath comes from src/client.ts, so its exact spelling is not ours to choose.
  assert.equal(canonicalOp("GET /api/v1/orders", "/api/v1/"), "GET /orders");
  const { summary } = run({ basePath: "/api/v1/" });
  assert.match(summary, /covers 1 of 2 spec operation\(s\)/);
});

test("an empty basePath canonicalizes nothing rather than mangling paths", () => {
  const { summary } = run({ basePath: "" });
  // With no prefix to strip, the two spellings stay two operations: 4 paths, 4
  // operations, 0 collapsed. The targeted `GET /api/v1/orders` still counts as
  // covered — it is a path the spec declares — so this is 1 of 4, and the twin
  // it covers is now a separate uncovered operation. That is the pre-fix
  // behaviour, which is the point: an empty prefix degrades to the old
  // undercount rather than mangling paths or throwing.
  assert.match(summary, /covers 1 of 4 spec operation\(s\) \(25\.0%\)/);
  assert.match(summary, /4 documented paths, 0 of them a second spelling/);
});

test("invariant G still catches an unaccounted-for path whose twin IS listed", () => {
  // The blind spot canonicalizing invariant G would create, and the reason it is
  // left comparing literal spellings: a spec release adds `GET /api/v1/widgets`
  // while only the bare `GET /widgets` is recorded. G must still fail.
  const { findings } = operationsDrift({
    specOps: SPEC,
    targeted: [line("GET /api/v1/orders")],
    uncovered: [line("GET /orders"), line("GET /widgets")], // /api/v1/widgets missing
    implemented: new Set(["GET /api/v1/orders"]),
    basePath: BASE,
    codeOnly: new Set(),
    nonRest: new Set(),
  });
  const g = findings.find((f: { label: string }) =>
    f.label.includes("neither targeted by endpoints.txt"),
  );
  assert.ok(g, `invariant G reported nothing; findings: ${JSON.stringify(findings)}`);
  assert.deepEqual(g.items, ["GET /api/v1/widgets"]);
});

test("a clean manifest produces no findings", () => {
  const { findings } = run();
  assert.deepEqual(findings, []);
});
