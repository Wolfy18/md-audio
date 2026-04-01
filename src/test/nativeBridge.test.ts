import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NativeBridge } from "../nativeBridge";

class FakeProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill(): void {
    this.killed = true;
    this.emit("exit", 0, null);
  }
}

test("routes requests and responses across the native bridge", async () => {
  const fakeProcess = new FakeProcess();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "md-audio-bridge-"));
  const binaryPath = path.join(tempDir, "md-audio-native");
  await writeFile(binaryPath, "");
  await chmod(binaryPath, 0o755);
  const bridge = new NativeBridge({
    extensionPath: tempDir,
    binaryResolver: () => binaryPath,
    spawnProcess: () => fakeProcess as never,
  });

  const requestChunk = new Promise<string>((resolve) => {
    fakeProcess.stdin.once("data", (chunk) => resolve(chunk.toString("utf8")));
  });
  const initPromise = bridge.init();
  const sent = await requestChunk;
  const parsed = JSON.parse(sent.trim()) as { id: string; type: string };

  fakeProcess.stdout.write(
    `${JSON.stringify({
      id: parsed.id,
      type: "init_result",
      available: true,
      backend: "system-tts",
    })}\n`,
  );

  const result = await initPromise;
  assert.equal(result.type, "init_result");
  assert.equal(result.available, true);

  bridge.dispose();
  assert.equal(fakeProcess.killed, true);
  await rm(tempDir, { force: true, recursive: true });
});
