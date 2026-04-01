import test from "node:test";
import assert from "node:assert/strict";
import { nativeBinaryName, resolvePlatformKey } from "../platform";

test("resolves supported platform keys", () => {
  assert.equal(resolvePlatformKey("darwin", "arm64"), "darwin-arm64");
  assert.equal(resolvePlatformKey("linux", "x64"), "linux-x64");
  assert.equal(resolvePlatformKey("win32", "x64"), "win32-x64");
});

test("returns correct binary name for Windows", () => {
  assert.equal(nativeBinaryName("win32-x64"), "md-audio-native.exe");
  assert.equal(nativeBinaryName("darwin-arm64"), "md-audio-native");
});

