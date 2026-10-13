// Tests for the surface reader in public-surface.mjs (ENG-18798), on synthetic
// packages written to a temp dir: its refusals, and the listing rules the
// header promises. public-surface.mjs runs this file before it generates or
// compares anything.
//
//   node --test scripts/release_gate/public-surface.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { surface } from "./public-surface.mjs";

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A packed-package stand-in: its package.json plus the given files. */
function pkg(
  files,
  manifest = { exports: { ".": { types: "./index.d.ts" } } },
) {
  const root = mkdtempSync(join(tmpdir(), "surface-test-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), body);
  }
  return root;
}

const listing = (source, extra = {}) =>
  surface(pkg({ "index.d.ts": source, ...extra }));

describe("refusals", () => {
  test("a package.json with no types entry", () => {
    const root = pkg({}, { name: "x" });
    assert.throws(() => surface(root), /declares no types entry/);
  });

  test("a types entry that is not in the package", () => {
    const root = pkg({});
    assert.throws(() => surface(root), /has no \.\/index\.d\.ts/);
  });

  test("an entry that is a script, not a module", () => {
    assert.throws(() => listing("declare const A: number;"), /is not a module/);
  });

  test("`export * as ns from` (a whole module under a name)", () => {
    assert.throws(
      () =>
        listing('export * as ns from "./inner.js";', {
          "inner.d.ts": "export declare const B: number;",
        }),
      /export "ns" is a whole module/,
    );
  });

  test("an export that resolves to no declaration", () => {
    assert.throws(
      () => listing('export { Nope } from "./missing.js";'),
      /export "Nope" resolves to no declaration/,
    );
  });
});

describe("listing", () => {
  test("`types` at the top level is read when `exports` has none", () => {
    const root = pkg(
      { "main.d.ts": "export declare const A: number;" },
      {
        types: "main.d.ts",
      },
    );
    assert.deepEqual(surface(root), ["const A: number"]);
  });

  test("one line per export, sorted by code unit", () => {
    assert.deepEqual(
      listing(
        "export declare function b(x: number): string;\nexport declare const a: boolean;\nexport type C = string | number;",
      ),
      [
        "const a: boolean",
        "function b(x: number): string",
        "type C = string | number",
      ],
    );
  });

  test("a constant is listed by its widened type, not its value", () => {
    assert.deepEqual(
      listing(
        'export declare const A = "1.2.3";\nexport declare const B = 7;\nexport declare const C = true;\nexport declare const D = -1;\nexport declare const E: "pinned";',
      ),
      [
        "const A: string",
        "const B: number",
        "const C: boolean",
        "const D: number",
        'const E: "pinned"',
      ],
    );
  });

  test("a constant with a non-literal initializer keeps its text", () => {
    assert.deepEqual(listing("export declare const F = [1, 2];"), [
      "const F: [1, 2]",
    ]);
  });

  test("an interface lists a line per member, so a retyped field shows", () => {
    const a = listing("export interface I { x: number; y?: string }");
    const b = listing("export interface I { x: string; y?: string }");
    assert.deepEqual(a, [
      "interface I",
      "interface I { x: number }",
      "interface I { y?: string }",
    ]);
    assert.notDeepEqual(a, b);
  });

  test("a class lists public members and a private constructor, not private ones", () => {
    assert.deepEqual(
      listing(
        "export declare class K { private constructor(); private secret; #hidden; open(): void; }",
      ),
      [
        "class K",
        "class K { open(): void }",
        "class K { private constructor() }",
      ],
    );
  });

  test("comments are not part of the listing", () => {
    assert.deepEqual(
      listing("/** doc */\nexport declare const A: number; // note"),
      listing("export declare const A: number;"),
    );
  });

  test("`export { type X }` of a class is marked type-only", () => {
    const lines = listing('export { type K } from "./k.js";', {
      "k.d.ts": "export declare class K { go(): void }",
    });
    assert.deepEqual(lines, [
      "type-only class K",
      "type-only class K { go(): void }",
    ]);
  });

  test("`export *` is followed to what the module exports", () => {
    assert.deepEqual(
      listing('export * from "./inner.js";', {
        "inner.d.ts": "export declare const B: number;",
      }),
      ["const B: number"],
    );
  });
});
