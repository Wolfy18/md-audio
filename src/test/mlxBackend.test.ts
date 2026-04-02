import test from "node:test";
import assert from "node:assert/strict";
import {
  batchPreparedUtterances,
  DEFAULT_KOKORO_ENGLISH_VOICE_ID,
  DEFAULT_KOKORO_SPANISH_VOICE_ID,
  kokoroLanguageCode,
  KOKORO_ENGLISH_SPEAKERS,
  KOKORO_SPEAKERS,
  KOKORO_SPANISH_SPEAKERS,
  managedMlxPythonPath,
  mlxVoiceLanguage,
  MlxBackend,
  normalizeUtteranceForSpeech,
  resolveMlxVoice,
  uvCommandCandidates,
  mlxVoicesForLanguage,
} from "../mlxBackend";
import type { MdAudioSettings } from "../settings";

const baseSettings: MdAudioSettings = {
  backend: "mlx-kokoro",
  voice: "",
  mlxEnglishVoice: "",
  mlxSpanishVoice: "",
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
  assert.equal(MlxBackend.speakerForLanguage(baseSettings, "en"), DEFAULT_KOKORO_ENGLISH_VOICE_ID);
  assert.equal(MlxBackend.speakerForLanguage(baseSettings, "es"), DEFAULT_KOKORO_SPANISH_VOICE_ID);
});

test("returns only voices that match the selected language", () => {
  assert.deepEqual(
    mlxVoicesForLanguage("en").map((voice) => voice.id),
    KOKORO_ENGLISH_SPEAKERS.map((voice) => voice.id),
  );
  assert.deepEqual(
    mlxVoicesForLanguage("es").map((voice) => voice.id),
    KOKORO_SPANISH_SPEAKERS.map((voice) => voice.id),
  );
});

test("exposes the curated Kokoro speaker list", () => {
  assert.deepEqual(
    KOKORO_SPEAKERS.map((voice) => voice.id),
    [...KOKORO_ENGLISH_SPEAKERS, ...KOKORO_SPANISH_SPEAKERS].map((voice) => voice.id),
  );
});

test("uses the configured Kokoro voice for each supported language", () => {
  const settings: MdAudioSettings = {
    ...baseSettings,
    mlxEnglishVoice: "af_heart",
    mlxSpanishVoice: "em_alex",
  };

  assert.equal(resolveMlxVoice(settings, "en").id, "af_heart");
  assert.equal(resolveMlxVoice(settings, "es").id, "em_alex");
});

test("falls back to the default voice when the configured Kokoro voice does not match the language", () => {
  const settings: MdAudioSettings = {
    ...baseSettings,
    mlxEnglishVoice: "em_alex",
    mlxSpanishVoice: "af_heart",
  };

  assert.equal(resolveMlxVoice(settings, "en").id, DEFAULT_KOKORO_ENGLISH_VOICE_ID);
  assert.equal(resolveMlxVoice(settings, "es").id, DEFAULT_KOKORO_SPANISH_VOICE_ID);
});

test("maps Kokoro voices back to English and Spanish", () => {
  assert.equal(mlxVoiceLanguage(resolveMlxVoice(baseSettings, "en")), "en");
  assert.equal(mlxVoiceLanguage(resolveMlxVoice(baseSettings, "es")), "es");
});

test("uses american english and spanish Kokoro language codes", () => {
  assert.equal(kokoroLanguageCode("en"), "a");
  assert.equal(kokoroLanguageCode("es"), "e");
});

test("adds sentence-ending punctuation for standalone speech fragments", () => {
  assert.equal(normalizeUtteranceForSpeech("Heading title"), "Heading title.");
  assert.equal(normalizeUtteranceForSpeech("Done: ship the docs"), "Done: ship the docs.");
  assert.equal(normalizeUtteranceForSpeech("Already complete."), "Already complete.");
  assert.equal(normalizeUtteranceForSpeech("Pause here,"), "Pause here,");
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
      { utterance_index: 0, text: "First sentence.", start_offset: 0, end_offset: 15, kind: "paragraph" },
      { utterance_index: 1, text: "Second sentence.", start_offset: 16, end_offset: 32, kind: "paragraph" },
      { utterance_index: 2, text: "Third sentence.", start_offset: 33, end_offset: 48, kind: "paragraph" },
      { utterance_index: 3, text: "Fourth sentence.", start_offset: 49, end_offset: 65, kind: "paragraph" },
      { utterance_index: 4, text: "Fifth sentence.", start_offset: 66, end_offset: 81, kind: "paragraph" },
      { utterance_index: 5, text: "Sixth sentence.", start_offset: 82, end_offset: 97, kind: "paragraph" },
      { utterance_index: 6, text: "Seventh sentence.", start_offset: 98, end_offset: 115, kind: "paragraph" },
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
    "First sentence.\n\nSecond sentence.\n\nThird sentence.",
  );
});

test("keeps headings in their own synthesis batch to preserve a natural pause", () => {
  const batches = batchPreparedUtterances([
    { utterance_index: 0, text: "Project Overview", start_offset: 0, end_offset: 16, kind: "heading" },
    {
      utterance_index: 1,
      text: "This paragraph explains the document in more detail.",
      start_offset: 17,
      end_offset: 69,
      kind: "paragraph",
    },
    {
      utterance_index: 2,
      text: "Another paragraph follows with supporting details.",
      start_offset: 70,
      end_offset: 119,
      kind: "paragraph",
    },
  ]);

  assert.equal(batches.length, 2);
  assert.equal(batches[0].text, "Project Overview.");
  assert.equal(
    batches[1].text,
    "This paragraph explains the document in more detail.\n\nAnother paragraph follows with supporting details.",
  );
});
