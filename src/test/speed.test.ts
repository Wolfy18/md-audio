import test from "node:test";
import assert from "node:assert/strict";
import { clampSpeed, formatSpeed } from "../speed";

test("formats common speed values cleanly", () => {
  assert.equal(formatSpeed(1), "1x");
  assert.equal(formatSpeed(1.1), "1.1x");
  assert.equal(formatSpeed(1.25), "1.25x");
});

test("clamps speed into the supported range", () => {
  assert.equal(clampSpeed(0.1), 0.5);
  assert.equal(clampSpeed(9), 2);
});
