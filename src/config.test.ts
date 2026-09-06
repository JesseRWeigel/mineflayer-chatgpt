import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCommandWhitelist } from "./config.js";

test("command whitelist is fail-closed and normalizes comma-separated names", () => {
  assert.deepEqual(parseCommandWhitelist(undefined), []);
  assert.deepEqual(parseCommandWhitelist(""), []);
  assert.deepEqual(parseCommandWhitelist(" Owner, helper ,, Builder "), ["Owner", "helper", "Builder"]);
});
