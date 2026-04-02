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

test("sends prepare_speech requests", async () => {
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
  const preparePromise = bridge.prepareSpeech({
    documentId: "file:///demo.md",
    startOffset: 4,
  });
  const sent = await requestChunk;
  const parsed = JSON.parse(sent.trim()) as {
    id: string;
    type: string;
    document_id: string;
    start_offset: number;
  };

  assert.equal(parsed.type, "prepare_speech");
  assert.equal(parsed.document_id, "file:///demo.md");
  assert.equal(parsed.start_offset, 4);

  fakeProcess.stdout.write(
    `${JSON.stringify({
      id: parsed.id,
      type: "prepare_speech_result",
      document_id: "file:///demo.md",
      language_code: "en",
      utterances: [],
    })}\n`,
  );

  const result = await preparePromise;
  assert.equal(result.type, "prepare_speech_result");
  assert.equal(result.language_code, "en");

  bridge.dispose();
  await rm(tempDir, { force: true, recursive: true });
});

test("sends prepare_summary requests", async () => {
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
  const preparePromise = bridge.prepareSummary("file:///demo.md");
  const sent = await requestChunk;
  const parsed = JSON.parse(sent.trim()) as {
    id: string;
    type: string;
    document_id: string;
  };

  assert.equal(parsed.type, "prepare_summary");
  assert.equal(parsed.document_id, "file:///demo.md");

  fakeProcess.stdout.write(
    `${JSON.stringify({
      id: parsed.id,
      type: "prepare_summary_result",
      document_id: "file:///demo.md",
      language_code: "en",
      utterances: [],
    })}\n`,
  );

  const result = await preparePromise;
  assert.equal(result.type, "prepare_summary_result");
  assert.equal(result.language_code, "en");

  bridge.dispose();
  await rm(tempDir, { force: true, recursive: true });
});

test("sends speak_summary requests", async () => {
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
  const speakPromise = bridge.speakSummary({
    documentId: "file:///demo.md",
    rate: 1,
  });
  const sent = await requestChunk;
  const parsed = JSON.parse(sent.trim()) as {
    id: string;
    type: string;
    document_id: string;
    rate: number;
  };

  assert.equal(parsed.type, "speak_summary");
  assert.equal(parsed.document_id, "file:///demo.md");
  assert.equal(parsed.rate, 1);

  fakeProcess.stdout.write(
    `${JSON.stringify({
      id: parsed.id,
      type: "speak_result",
      document_id: "file:///demo.md",
      queued: 3,
    })}\n`,
  );

  const result = await speakPromise;
  assert.equal(result.type, "speak_result");
  assert.equal(result.queued, 3);

  bridge.dispose();
  await rm(tempDir, { force: true, recursive: true });
});
