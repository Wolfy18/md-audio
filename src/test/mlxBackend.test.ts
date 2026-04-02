import test from "node:test";
import assert from "node:assert/strict";
import {
  batchPreparedUtterances,
  KOKORO_SPEAKERS,
  managedMlxPythonPath,
  MlxBackend,
  uvCommandCandidates,
  mlxVoicesForLanguage,
} from "../mlxBackend";
import type { MdAudioSettings } from "../settings";

const baseSettings: MdAudioSettings = {
  backend: "mlx-kokoro",
  voice: "",
  rate: 1,
  highlightCurrentUtterance: true,
  showEditorButtons: true,
  enabledLanguages: ["markdown"],
  uvPath: "uv",
  mlxModel: "mlx-community/Kokoro-82M-bf16",
};

test("resolves document languages for MLX playback", () => {
  assert.equal(MlxBackend.resolveLanguageCode("es"), "es");
  assert.equal(MlxBackend.resolveLanguageCode("en"), "en");
  assert.equal(MlxBackend.resolveLanguageCode(undefined), "en");
});

test("chooses the configured speaker for each language", () => {
  assert.equal(MlxBackend.speakerForLanguage(baseSettings, "en"), "am_adam");
  assert.equal(MlxBackend.speakerForLanguage(baseSettings, "es"), "am_adam");
});

test("returns only voices that match the selected language", () => {
  assert.deepEqual(
    mlxVoicesForLanguage("en").map((voice) => voice.id),
    ["am_adam"],
  );
  assert.deepEqual(
    mlxVoicesForLanguage("es").map((voice) => voice.id),
    ["am_adam"],
  );
});

test("exposes the curated Kokoro speaker list", () => {
  assert.deepEqual(KOKORO_SPEAKERS.map((voice) => voice.id), ["am_adam"]);
});

test("builds uv command candidates without relying on the workspace", () => {
  const candidates = uvCommandCandidates("", "darwin", "/Users/demo");

  assert.deepEqual(candidates, ["/Users/demo/.local/bin/uv", "/opt/homebrew/bin/uv", "/usr/local/bin/uv", "uv"]);
});

test("keeps an explicit uv executable first when provided", () => {
  const candidates = uvCommandCandidates("/custom/uv", "darwin", "/Users/demo");

  assert.equal(candidates[0], "/custom/uv");
});

test("builds a deterministic managed Python path under extension storage", () => {
  assert.equal(
    managedMlxPythonPath("/storage/md-audio", "darwin"),
    "/storage/md-audio/mlx-kokoro/.venv/bin/python",
  );
});

test("batches prepared utterances into larger synthesis chunks", () => {
  const batches = batchPreparedUtterances(
    [
      { utterance_index: 0, text: "First sentence.", start_offset: 0, end_offset: 15 },
      { utterance_index: 1, text: "Second sentence.", start_offset: 16, end_offset: 32 },
      { utterance_index: 2, text: "Third sentence.", start_offset: 33, end_offset: 48 },
      { utterance_index: 3, text: "Fourth sentence.", start_offset: 49, end_offset: 65 },
      { utterance_index: 4, text: "Fifth sentence.", start_offset: 66, end_offset: 81 },
      { utterance_index: 5, text: "Sixth sentence.", start_offset: 82, end_offset: 97 },
      { utterance_index: 6, text: "Seventh sentence.", start_offset: 98, end_offset: 115 },
    ],
    {
      maxUtterances: 3,
      maxCharacters: 200,
    },
  );

  assert.equal(batches.length, 3);
  assert.deepEqual(
    batches.map((batch) => ({
      utteranceIndex: batch.utteranceIndex,
      utteranceCount: batch.utteranceCount,
      startOffset: batch.startOffset,
      endOffset: batch.endOffset,
    })),
    [
      { utteranceIndex: 0, utteranceCount: 3, startOffset: 0, endOffset: 48 },
      { utteranceIndex: 3, utteranceCount: 3, startOffset: 49, endOffset: 97 },
      { utteranceIndex: 6, utteranceCount: 1, startOffset: 98, endOffset: 115 },
    ],
  );
  assert.equal(
    batches[0].text,
    "First sentence. Second sentence. Third sentence.",
  );
});
