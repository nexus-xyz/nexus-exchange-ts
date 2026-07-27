import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { SDK_VERSION, API_VERSION } from "../src/index.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

test("SDK_VERSION is a non-empty string", () => {
  assert.equal(typeof SDK_VERSION, "string");
  assert.ok(SDK_VERSION.length > 0);
});

test("API_VERSION looks like a vMAJOR.MINOR.PATCH spec tag", () => {
  assert.match(API_VERSION, /^v\d+\.\d+\.\d+$/);
});

test("API_VERSION stays in lockstep with the pinned .api-version", () => {
  // The `X-Nexus-Api-Version` header derives from API_VERSION, which must equal
  // the repo's `.api-version` pin (the same pin the spec-drift gate enforces).
  // This keeps the constant from silently drifting when the pin is bumped.
  const pinned = readFileSync(join(REPO, ".api-version"), "utf8").trim();
  assert.equal(API_VERSION, pinned);
});
