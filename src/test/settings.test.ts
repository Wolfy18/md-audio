import test from "node:test";
import assert from "node:assert/strict";
import { readSettings } from "../settings";

test("reads settings with defaults", () => {
  const settings = readSettings({
    get(key, defaultValue) {
      return defaultValue;
    },
  });

  assert.equal(settings.voice, "");
  assert.equal(settings.rate, 1);
  assert.deepEqual(settings.enabledLanguages, ["markdown"]);
});

test("normalizes the configured voice and languages", () => {
  const settings = readSettings({
    get(key, defaultValue) {
      if (key === "voice") {
        return "  com.apple.voice  " as typeof defaultValue;
      }
      if (key === "enabledLanguages") {
        return ["markdown", " mdx "] as typeof defaultValue;
      }
      return defaultValue;
    },
  });

  assert.equal(settings.voice, "com.apple.voice");
  assert.deepEqual(settings.enabledLanguages, ["markdown", "mdx"]);
});
