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
  assert.equal(settings.backend, "auto");
  assert.equal(settings.rate, 1);
  assert.deepEqual(settings.enabledLanguages, ["markdown"]);
  assert.equal(settings.uvPath, "");
  assert.equal(settings.mlxModel, "mlx-community/Kokoro-82M-bf16");
});

test("normalizes the configured voice and languages", () => {
  const settings = readSettings({
    get(key, defaultValue) {
      if (key === "backend") {
        return "mlx-qwen" as typeof defaultValue;
      }
      if (key === "voice") {
        return "  com.apple.voice  " as typeof defaultValue;
      }
      if (key === "enabledLanguages") {
        return ["markdown", " mdx "] as typeof defaultValue;
      }
      return defaultValue;
    },
  });

  assert.equal(settings.backend, "mlx-kokoro");
  assert.equal(settings.voice, "com.apple.voice");
  assert.deepEqual(settings.enabledLanguages, ["markdown", "mdx"]);
});

test("clamps invalid configured speed values", () => {
  const settings = readSettings({
    get(key, defaultValue) {
      if (key === "rate") {
        return 10 as typeof defaultValue;
      }

      return defaultValue;
    },
  });

  assert.equal(settings.rate, 2);
});

test("falls back to auto for unknown backends", () => {
  const settings = readSettings({
    get(key, defaultValue) {
      if (key === "backend") {
        return "broken" as typeof defaultValue;
      }

      return defaultValue;
    },
  });

  assert.equal(settings.backend, "auto");
});
