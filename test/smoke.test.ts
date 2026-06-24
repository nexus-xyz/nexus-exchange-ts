import { test } from "node:test";
import assert from "node:assert/strict";

import { SDK_VERSION } from "../src/index.ts";

test("SDK_VERSION is a non-empty string", () => {
  assert.equal(typeof SDK_VERSION, "string");
  assert.ok(SDK_VERSION.length > 0);
});
