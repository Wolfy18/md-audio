import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { supportsMlxLocal } from "./platform";
import type { NativeUtteranceEvent, NativeVoice, PreparedUtterance, PreparedUtteranceKind } from "./protocol";
import type { MdAudioSettings } from "./settings";

export const MLX_BACKEND_ID = "mlx-kokoro";
export const MLX_STOPPED_MESSAGE = "MD Audio local playback stopped.";
const MLX_BATCH_MAX_CHARACTERS = 650;
const MLX_BATCH_MAX_UTTERANCES = 6;
const MLX_ENV_DIRECTORY = "mlx-kokoro";
const MLX_VENV_DIRECTORY = ".venv";
const MLX_MANAGED_PYTHON_VERSION = "3.12";
const KOKORO_REQUIRED_PYTHON_MODULES = [
  "mlx_audio",
  "misaki",
  "num2words",
  "spacy",
  "phonemizer",
  "espeakng_loader",
  "en_core_web_sm",
] as const;
const MLX_REQUIRED_PACKAGES = ["mlx-audio", "misaki", "num2words", "spacy", "phonemizer-fork", "espeakng-loader"] as const;
const createVoice = (id: string, name: string, locale: string, gender: string): NativeVoice => ({
  id,
  name,
  locale,
  gender,
});

export const DEFAULT_KOKORO_ENGLISH_VOICE_ID = "af_bella";
export const DEFAULT_KOKORO_SPANISH_VOICE_ID = "ef_dora";

export const KOKORO_ENGLISH_SPEAKERS: readonly NativeVoice[] = [
  createVoice("af_alloy", "Alloy", "en-US", "female"),
  createVoice("af_aoede", "Aoede", "en-US", "female"),
  createVoice("af_bella", "Bella", "en-US", "female"),
  createVoice("af_heart", "Heart", "en-US", "female"),
  createVoice("af_jessica", "Jessica", "en-US", "female"),
  createVoice("af_kore", "Kore", "en-US", "female"),
  createVoice("af_nicole", "Nicole", "en-US", "female"),
  createVoice("af_nova", "Nova", "en-US", "female"),
  createVoice("af_river", "River", "en-US", "female"),
  createVoice("af_sarah", "Sarah", "en-US", "female"),
  createVoice("af_sky", "Sky", "en-US", "female"),
  createVoice("am_adam", "Adam", "en-US", "male"),
  createVoice("am_echo", "Echo", "en-US", "male"),
  createVoice("am_eric", "Eric", "en-US", "male"),
  createVoice("am_fenrir", "Fenrir", "en-US", "male"),
  createVoice("am_liam", "Liam", "en-US", "male"),
  createVoice("am_michael", "Michael", "en-US", "male"),
  createVoice("am_onyx", "Onyx", "en-US", "male"),
  createVoice("am_puck", "Puck", "en-US", "male"),
  createVoice("am_santa", "Santa", "en-US", "male"),
] as const;

export const KOKORO_SPANISH_SPEAKERS: readonly NativeVoice[] = [
  createVoice("ef_dora", "Dora", "es-ES", "female"),
  createVoice("em_alex", "Alex", "es-ES", "male"),
  createVoice("em_santa", "Santa", "es-ES", "male"),
] as const;

export const KOKORO_SPEAKERS: readonly NativeVoice[] = [
  ...KOKORO_ENGLISH_SPEAKERS,
  ...KOKORO_SPANISH_SPEAKERS,
] as const;

export type PlaybackLanguage = "en" | "es";

export interface MlxPreparedSpeech {
  documentId: string;
  utterances: readonly PreparedUtterance[];
  batches?: readonly MlxPlaybackBatch[];
  languageCode?: string;
  rate: number;
}

export interface MlxPlaybackBatch {
  utteranceIndex: number;
  utteranceCount: number;
  text: string;
  startOffset: number;
  endOffset: number;
}

export interface MlxBackendStatus {
  available: boolean;
  backend: string;
  message?: string;
}

export interface MlxBackendOptions {
  extensionPath: string;
  storagePath: string;
  log?: (message: string) => void;
  spawnProcess?: (
    command: string,
    args: readonly string[],
    options: {
      readonly env?: NodeJS.ProcessEnv;
      readonly stdio?: "pipe";
    },
  ) => ChildProcessWithoutNullStreams;
}

interface WorkerResponse {
  id: string;
  type: "pong" | "model_ready" | "synthesize_result" | "error";
  message?: string;
  output_path?: string;
}

interface WorkerRequest {
  id: string;
  type: "ping" | "ensure_model" | "synthesize";
  model?: string;
  text?: string;
  voice?: string;
  lang_code?: string;
  speed?: number;
  output_path?: string;
}

interface PendingRequest {
  resolve: (response: WorkerResponse) => void;
  reject: (error: Error) => void;
}

const TERMINAL_PUNCTUATION = /[.!?…]$/u;
const CONTINUATION_PUNCTUATION = /[,;:]$/u;

export function isMlxSupportedPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): boolean {
  return supportsMlxLocal(platform, arch);
}

export function normalizeMlxLanguage(languageCode: string | undefined): PlaybackLanguage {
  return languageCode === "es" ? "es" : "en";
}

export function mlxVoicesForLanguage(languageCode: PlaybackLanguage): readonly NativeVoice[] {
  return languageCode === "es" ? KOKORO_SPANISH_SPEAKERS : KOKORO_ENGLISH_SPEAKERS;
}

export function mlxVoiceLanguage(voice: NativeVoice): PlaybackLanguage {
  return voice.locale?.startsWith("es") ? "es" : "en";
}

export function resolveMlxVoice(settings: MdAudioSettings, languageCode: PlaybackLanguage): NativeVoice {
  const configuredVoiceId =
    languageCode === "es" ? settings.mlxSpanishVoice.trim() : settings.mlxEnglishVoice.trim();
  const matchingVoices = mlxVoicesForLanguage(languageCode);
  const matchingVoice = matchingVoices.find((voice) => voice.id === configuredVoiceId);

  if (matchingVoice) {
    return matchingVoice;
  }

  const fallbackVoiceId =
    languageCode === "es" ? DEFAULT_KOKORO_SPANISH_VOICE_ID : DEFAULT_KOKORO_ENGLISH_VOICE_ID;
  return matchingVoices.find((voice) => voice.id === fallbackVoiceId) ?? matchingVoices[0];
}

export function kokoroLanguageCode(languageCode: PlaybackLanguage): string {
  if (languageCode === "es") {
    return "e";
  }

  return "a";
}

export function managedMlxEnvironmentPath(storagePath: string): string {
  return path.join(storagePath, MLX_ENV_DIRECTORY);
}

export function managedMlxUvCachePath(storagePath: string): string {
  return path.join(managedMlxEnvironmentPath(storagePath), ".uv-cache");
}

export function managedMlxUvPythonInstallPath(storagePath: string): string {
  return path.join(managedMlxEnvironmentPath(storagePath), ".uv-python");
}

export function managedMlxPipCachePath(storagePath: string): string {
  return path.join(managedMlxEnvironmentPath(storagePath), ".pip-cache");
}

export function managedMlxPythonPath(
  storagePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32"
    ? path.join(managedMlxEnvironmentPath(storagePath), MLX_VENV_DIRECTORY, "Scripts", "python.exe")
    : path.join(managedMlxEnvironmentPath(storagePath), MLX_VENV_DIRECTORY, "bin", "python");
}

export function uvCommandCandidates(
  configuredPath: string,
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = os.homedir(),
): string[] {
  const candidates: string[] = [];
  const push = (value: string | undefined) => {
    const normalized = value?.trim();
    if (!normalized || candidates.includes(normalized)) {
      return;
    }

    candidates.push(normalized);
  };

  push(configuredPath);
  if (platform !== "win32") {
    push(path.join(homeDirectory, ".local", "bin", "uv"));
    push("/opt/homebrew/bin/uv");
    push("/usr/local/bin/uv");
  }
  push("uv");

  return candidates;
}

export function batchPreparedUtterances(
  utterances: readonly PreparedUtterance[],
  options: {
    maxCharacters?: number;
    maxUtterances?: number;
  } = {},
): MlxPlaybackBatch[] {
  const maxCharacters = options.maxCharacters ?? MLX_BATCH_MAX_CHARACTERS;
  const maxUtterances = options.maxUtterances ?? MLX_BATCH_MAX_UTTERANCES;
  const batches: MlxPlaybackBatch[] = [];
  let currentBatch: PreparedUtterance[] = [];
  let currentLength = 0;

  const flushBatch = () => {
    if (currentBatch.length === 0) {
      return;
    }

    const firstUtterance = currentBatch[0];
    const lastUtterance = currentBatch[currentBatch.length - 1];
    batches.push({
      utteranceIndex: firstUtterance.utterance_index,
      utteranceCount: currentBatch.length,
      text: renderBatchText(currentBatch),
      startOffset: firstUtterance.start_offset,
      endOffset: lastUtterance.end_offset,
    });

    currentBatch = [];
    currentLength = 0;
  };

  for (const utterance of utterances) {
    const utteranceText = normalizeUtteranceForSpeech(utterance.text);
    if (!utteranceText) {
      continue;
    }

    const lastUtterance = currentBatch[currentBatch.length - 1];
    const requiresStrongBoundary =
      currentBatch.length > 0 &&
      (isHeadingLikeUtterance(lastUtterance.kind) || isHeadingLikeUtterance(utterance.kind));

    const separatorLength = currentBatch.length === 0 ? 0 : 2;
    const nextLength = currentLength + separatorLength + utteranceText.length;
    const wouldOverflow = currentBatch.length > 0 && nextLength > maxCharacters;
    const reachedBatchLimit = currentBatch.length >= maxUtterances;

    if (requiresStrongBoundary || wouldOverflow || reachedBatchLimit) {
      flushBatch();
    }

    currentBatch.push(utterance);
    currentLength += (currentBatch.length === 1 ? 0 : 2) + utteranceText.length;
  }

  flushBatch();
  return batches;
}

function isHeadingLikeUtterance(kind: PreparedUtteranceKind): boolean {
  return kind === "heading";
}

function renderBatchText(utterances: readonly PreparedUtterance[]): string {
  return utterances
    .map((utterance) => normalizeUtteranceForSpeech(utterance.text))
    .filter((text) => text.length > 0)
    .join("\n\n");
}

export function normalizeUtteranceForSpeech(text: string): string {
  const normalized = text.trim().replace(/\s+/gu, " ");
  if (!normalized) {
    return "";
  }

  if (TERMINAL_PUNCTUATION.test(normalized) || CONTINUATION_PUNCTUATION.test(normalized)) {
    return normalized;
  }

  return `${normalized}.`;
}

export class MlxBackend {
  private readonly extensionPath: string;
  private readonly storagePath: string;
  private readonly log: (message: string) => void;
  private readonly spawnProcess;
  private readonly pending = new Map<string, PendingRequest>();
  private workerProcess?: ChildProcessWithoutNullStreams;
  private workerBuffer = "";
  private nextRequestId = 0;
  private bootPromise?: Promise<void>;
  private currentPlaybackId = 0;
  private currentAudioProcess?: ChildProcess;
  private currentTempDir?: string;
  private currentSynthesisInFlight = false;
  private provisionPromise?: Promise<void>;
  private resolvedPythonPath?: string;

  constructor(options: MlxBackendOptions) {
    this.extensionPath = options.extensionPath;
    this.storagePath = options.storagePath;
    this.log = options.log ?? (() => undefined);
    this.spawnProcess =
      options.spawnProcess ??
      ((command, args, spawnOptions) =>
        spawn(command, [...args], {
          env: spawnOptions.env,
          stdio: spawnOptions.stdio ?? "pipe",
        }));
  }

  static resolveLanguageCode(languageCode: string | undefined): PlaybackLanguage {
    return normalizeMlxLanguage(languageCode);
  }

  static speakerForLanguage(settings: MdAudioSettings, languageCode: PlaybackLanguage): string {
    return resolveMlxVoice(settings, languageCode).id;
  }

  static isPreferredPlatform(): boolean {
    return isMlxSupportedPlatform();
  }

  listVoices(): readonly NativeVoice[] {
    return KOKORO_SPEAKERS;
  }

  async check(settings: MdAudioSettings, allowModelLoad = false): Promise<MlxBackendStatus> {
    if (!isMlxSupportedPlatform()) {
      return {
        available: false,
        backend: MLX_BACKEND_ID,
        message: `MLX Kokoro local TTS requires macOS on Apple Silicon. Current platform is ${process.platform}-${process.arch}.`,
      };
    }

    try {
      const pythonPath = await this.resolvePythonPath(settings);
      this.setPythonPath(pythonPath);
      await this.ensureWorker();
      if (allowModelLoad) {
        await this.ensureModelLoaded(settings);
      }

      return {
        available: true,
        backend: `${MLX_BACKEND_ID} (${settings.mlxModel})`,
      };
    } catch (error) {
      return {
        available: false,
        backend: MLX_BACKEND_ID,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async playPrepared(
    settings: MdAudioSettings,
    prepared: MlxPreparedSpeech,
    onEvent: (event: NativeUtteranceEvent) => void,
  ): Promise<void> {
    const pythonPath = await this.resolvePythonPath(settings);
    this.setPythonPath(pythonPath);
    await this.ensureWorker();
    await this.ensureModelLoaded(settings);

    const playbackId = ++this.currentPlaybackId;
    const languageCode = normalizeMlxLanguage(prepared.languageCode);
    const selectedVoice = resolveMlxVoice(settings, languageCode);
    const speaker = selectedVoice.id;
    const langCode = kokoroLanguageCode(languageCode);
    const batches = prepared.batches ?? batchPreparedUtterances(prepared.utterances);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "md-audio-mlx-"));
    this.currentTempDir = tempDir;

    try {
      for (const batch of batches) {
        this.assertPlaybackActive(playbackId);

        onEvent({
          type: "utterance_begin",
          document_id: prepared.documentId,
          utterance_index: batch.utteranceIndex,
          start_offset: batch.startOffset,
          end_offset: batch.endOffset,
          text: batch.text,
        });

        const audioPath = path.join(tempDir, `utterance-${batch.utteranceIndex}.wav`);
        await this.synthesizeUtterance(
          settings,
          batch.text,
          audioPath,
          speaker,
          langCode,
          prepared.rate,
          playbackId,
        );
        await this.playAudioFile(audioPath, playbackId);
        this.assertPlaybackActive(playbackId);

        onEvent({
          type: "utterance_end",
          document_id: prepared.documentId,
          utterance_index: batch.utteranceIndex,
          start_offset: batch.startOffset,
          end_offset: batch.endOffset,
          text: batch.text,
        });
      }
    } catch (error) {
      if (isPlaybackStoppedError(error)) {
        return;
      }

      throw error;
    } finally {
      if (this.currentTempDir === tempDir) {
        this.currentTempDir = undefined;
      }
      await rm(tempDir, { force: true, recursive: true });
    }
  }

  async stop(): Promise<void> {
    this.currentPlaybackId += 1;

    if (this.currentAudioProcess && !this.currentAudioProcess.killed) {
      this.currentAudioProcess.kill("SIGKILL");
    }
    this.currentAudioProcess = undefined;

    if (this.currentSynthesisInFlight) {
      this.disposeWorker(MLX_STOPPED_MESSAGE);
    }

    if (this.currentTempDir) {
      const tempDir = this.currentTempDir;
      this.currentTempDir = undefined;
      await rm(tempDir, { force: true, recursive: true });
    }
  }

  dispose(): void {
    void this.stop();
    this.disposeWorker("MLX worker disposed.");
  }

  private async resolvePythonPath(settings: MdAudioSettings): Promise<string> {
    const configuredPath = settings.uvPath.trim();
    if (this.resolvedPythonPath && configuredPath === this.lastConfiguredPythonPath) {
      return this.resolvedPythonPath;
    }

    const managedPythonPath = managedMlxPythonPath(this.storagePath);
    const managedProbe = await this.canUsePython(managedPythonPath);
    if (managedProbe.available) {
      this.resolvedPythonPath = managedPythonPath;
      this.lastConfiguredPythonPath = configuredPath;
      return managedPythonPath;
    }

    await this.ensureManagedEnvironment(configuredPath);

    const provisionedProbe = await this.canUsePython(managedPythonPath);
    if (!provisionedProbe.available) {
      throw new Error(
        [
          `MD Audio created a managed MLX environment at '${managedPythonPath}', but it is still unavailable.`,
          provisionedProbe.message ?? "The managed interpreter did not report 'mlx_audio'.",
        ]
          .join(" ")
          .trim(),
      );
    }

    this.resolvedPythonPath = managedPythonPath;
    this.lastConfiguredPythonPath = configuredPath;
    return managedPythonPath;
  }

  private async ensureManagedEnvironment(configuredPath: string): Promise<void> {
    this.provisionPromise ??= this.provisionManagedEnvironment(configuredPath);

    try {
      await this.provisionPromise;
    } finally {
      this.provisionPromise = undefined;
    }
  }

  private async provisionManagedEnvironment(configuredPath: string): Promise<void> {
    const uvCommand = await this.resolveUvCommand(configuredPath);
    const environmentPath = managedMlxEnvironmentPath(this.storagePath);
    const venvPath = path.join(environmentPath, MLX_VENV_DIRECTORY);
    const managedPython = managedMlxPythonPath(this.storagePath);

    this.log(`[mlx-env] Provisioning managed MLX environment at ${environmentPath}`);
    await mkdir(environmentPath, { recursive: true });
    await rm(venvPath, { force: true, recursive: true });

    await this.runCommand(
      uvCommand,
      ["python", "install", MLX_MANAGED_PYTHON_VERSION],
      `install Python ${MLX_MANAGED_PYTHON_VERSION} with uv`,
    );
    await this.runCommand(
      uvCommand,
      ["venv", "--no-project", "--python", MLX_MANAGED_PYTHON_VERSION, "--seed", "--clear", venvPath],
      `create the managed MLX Python ${MLX_MANAGED_PYTHON_VERSION} environment`,
    );
    await this.runCommand(
      uvCommand,
      ["pip", "install", "--python", managedPython, "--upgrade", ...MLX_REQUIRED_PACKAGES],
      "install the managed MLX Python dependencies",
    );
    await this.runCommand(
      managedPython,
      ["-m", "spacy", "download", "en_core_web_sm"],
      "install the spaCy English model required by Kokoro",
    );
  }

  private async resolveUvCommand(configuredPath: string): Promise<string> {
    const candidates = uvCommandCandidates(configuredPath);
    let configuredCandidateError: string | undefined;

    for (const candidate of candidates) {
      const result = await this.canUseUv(candidate);
      if (result.available) {
        return candidate;
      }

      if (candidate === configuredPath && result.message) {
        configuredCandidateError = result.message;
      }
    }

    const checked = candidates.map((candidate) => `'${candidate}'`).join(", ");
    const configuredDetail =
      configuredPath && configuredCandidateError
        ? ` Configured uv executable '${configuredPath}' failed: ${configuredCandidateError}.`
        : "";

    throw new Error(
      `MD Audio could not find the 'uv' executable to create its managed MLX environment. Checked ${checked}.${configuredDetail} Install uv or set mdAudio.uvPath.`,
    );
  }

  private async ensureWorker(): Promise<void> {
    if (this.workerProcess) {
      return;
    }

    this.bootPromise ??= this.startWorker();

    try {
      await this.bootPromise;
    } finally {
      this.bootPromise = undefined;
    }
  }

  private async startWorker(): Promise<void> {
    const pythonPath = this.getPythonPath();
    const workerPath = path.join(this.extensionPath, "python", "mlx_worker.py");

    const child = this.spawnProcess(pythonPath, [workerPath], {
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
      },
      stdio: "pipe",
    });
    this.workerProcess = child;

    child.stdout.on("data", (chunk: Buffer | string) => {
      this.handleWorkerStdout(chunk.toString("utf8"));
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      const message = chunk.toString("utf8").trim();
      if (message) {
        this.log(`[mlx-worker] ${message}`);
      }
    });

    child.on("exit", (code, signal) => {
      const reason = `MLX worker exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`;
      this.log(reason);
      this.rejectPending(reason);
      if (this.workerProcess === child) {
        this.workerProcess = undefined;
      }
    });

    child.on("error", (error) => {
      this.log(`[mlx-worker] ${error.message}`);
    });

    try {
      await this.send({
        type: "ping",
      });
    } catch (error) {
      this.disposeWorker(buildWorkerFailureMessage(error, pythonPath));
      throw new Error(buildWorkerFailureMessage(error, pythonPath));
    }
  }

  private async ensureModelLoaded(settings: MdAudioSettings): Promise<void> {
    await this.send({
      type: "ensure_model",
      model: settings.mlxModel,
    });
  }

  private async synthesizeUtterance(
    settings: MdAudioSettings,
    text: string,
    outputPath: string,
    speaker: string,
    langCode: string,
    rate: number,
    playbackId: number,
  ): Promise<void> {
    this.currentSynthesisInFlight = true;

    try {
      const response = await this.send({
        type: "synthesize",
        model: settings.mlxModel,
        text,
        voice: speaker,
        lang_code: langCode,
        speed: rate,
        output_path: outputPath,
      });

      this.assertPlaybackActive(playbackId);

      if (response.type !== "synthesize_result") {
        throw new Error("MLX synthesis returned an unexpected response.");
      }
    } finally {
      this.currentSynthesisInFlight = false;
    }
  }

  private async playAudioFile(audioPath: string, playbackId: number): Promise<void> {
    this.assertPlaybackActive(playbackId);

    const child = spawn("/usr/bin/afplay", [audioPath], {
      stdio: "ignore",
    });
    this.currentAudioProcess = child;

    try {
      const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
      this.assertPlaybackActive(playbackId);

      if (code !== 0) {
        throw new Error(`MD Audio could not play the generated audio (code=${code ?? "null"}, signal=${signal ?? "null"}).`);
      }
    } finally {
      if (this.currentAudioProcess === child) {
        this.currentAudioProcess = undefined;
      }
    }
  }

  private assertPlaybackActive(playbackId: number): void {
    if (this.currentPlaybackId !== playbackId) {
      throw new Error(MLX_STOPPED_MESSAGE);
    }
  }

  private async send(request: Omit<WorkerRequest, "id">): Promise<WorkerResponse> {
    if (!this.workerProcess) {
      throw new Error("The MLX worker is not running.");
    }

    const id = `${++this.nextRequestId}`;
    const payload: WorkerRequest = {
      ...request,
      id,
    };

    const promise = new Promise<WorkerResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    this.workerProcess.stdin.write(`${JSON.stringify(payload)}\n`, "utf8");
    const response = await promise;

    if (response.type === "error") {
      throw new Error(response.message ?? "The MLX worker reported an unknown error.");
    }

    return response;
  }

  private handleWorkerStdout(chunk: string): void {
    this.workerBuffer += chunk;
    const lines = this.workerBuffer.split("\n");
    this.workerBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let parsed: WorkerResponse;
      try {
        parsed = JSON.parse(trimmed) as WorkerResponse;
      } catch (error) {
        this.log(`[mlx-worker] Failed to parse stdout: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }

      const pending = this.pending.get(parsed.id);
      if (!pending) {
        continue;
      }

      this.pending.delete(parsed.id);
      pending.resolve(parsed);
    }
  }

  private disposeWorker(reason: string): void {
    this.rejectPending(reason);
    this.bootPromise = undefined;

    if (this.workerProcess && !this.workerProcess.killed) {
      this.workerProcess.kill("SIGKILL");
    }
    this.workerProcess = undefined;
    this.workerBuffer = "";
  }

  private rejectPending(reason: string): void {
    for (const [, pending] of this.pending) {
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private getPythonPath(): string {
    return (this.lastSettingsPythonPath ?? "").trim() || managedMlxPythonPath(this.storagePath);
  }

  private lastSettingsPythonPath?: string;
  private lastConfiguredPythonPath?: string;

  setPythonPath(pythonPath: string): void {
    const normalized = pythonPath.trim() || managedMlxPythonPath(this.storagePath);
    if (this.lastSettingsPythonPath && this.lastSettingsPythonPath !== normalized) {
      this.disposeWorker("Python interpreter changed.");
    }

    this.lastSettingsPythonPath = normalized;
  }

  private async canUseUv(candidate: string): Promise<{ available: boolean; message?: string }> {
    if (candidate.includes(path.sep)) {
      try {
        await access(candidate, fsConstants.X_OK);
      } catch {
        return {
          available: false,
          message: "not executable",
        };
      }
    }

    return new Promise((resolve) => {
      const child = this.spawnProcess(candidate, ["--version"], {
        env: process.env,
        stdio: "pipe",
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (result: { available: boolean; message?: string }) => {
        if (settled) {
          return;
        }

        settled = true;
        resolve(result);
      };

      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        finish({
          available: false,
          message: "probe timed out",
        });
      }, 5_000);

      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        finish({
          available: false,
          message: error.message,
        });
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        if (code === 0 && stdout.trim().startsWith("uv ")) {
          finish({ available: true });
          return;
        }

        finish({
          available: false,
          message: stderr.trim() || stdout.trim() || `exit ${code ?? "null"}`,
        });
      });
    });
  }

  private async canUsePython(candidate: string): Promise<{ available: boolean; message?: string }> {
    return this.runPythonProbe(
      candidate,
      [
        "import importlib.util, sys",
        `required = ${JSON.stringify([...KOKORO_REQUIRED_PYTHON_MODULES])}`,
        "missing = [name for name in required if importlib.util.find_spec(name) is None]",
        "if missing:",
        "    sys.stderr.write('missing modules: ' + ', '.join(missing) + '\\n')",
        "else:",
        "    from phonemizer.backend.espeak.wrapper import EspeakWrapper",
        "    if not hasattr(EspeakWrapper, 'set_data_path'):",
        "        sys.stderr.write('incompatible phonemizer backend: EspeakWrapper.set_data_path is missing\\n')",
        "        sys.exit(1)",
        "    sys.stdout.write(sys.executable + '\\n')",
      ].join("\n"),
    );
  }

  private async runPythonProbe(candidate: string, probeCode: string): Promise<{ available: boolean; message?: string }> {
    if (candidate.includes(path.sep)) {
      try {
        await access(candidate, fsConstants.X_OK);
      } catch {
        return {
          available: false,
          message: "not executable",
        };
      }
    }

    return new Promise((resolve) => {
      const child = this.spawnProcess(candidate, ["-c", probeCode], {
        env: process.env,
        stdio: "pipe",
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (result: { available: boolean; message?: string }) => {
        if (settled) {
          return;
        }

        settled = true;
        resolve(result);
      };

      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        finish({
          available: false,
          message: "probe timed out",
        });
      }, 5_000);

      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        finish({
          available: false,
          message: error.message,
        });
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        const executable = stdout.trim();
        if (code === 0 && executable) {
          finish({ available: true });
          return;
        }

        finish({
          available: false,
          message: stderr.trim() || `exit ${code ?? "null"}`,
        });
      });
    });
  }

  private async runCommand(command: string, args: readonly string[], action: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = this.spawnProcess(command, args, {
        env: {
          ...process.env,
          PIP_DISABLE_PIP_VERSION_CHECK: "1",
          PIP_CACHE_DIR: managedMlxPipCachePath(this.storagePath),
          PYTHONUNBUFFERED: "1",
          UV_NO_PROGRESS: "1",
          UV_CACHE_DIR: managedMlxUvCachePath(this.storagePath),
          UV_PYTHON_INSTALL_DIR: managedMlxUvPythonInstallPath(this.storagePath),
        },
        stdio: "pipe",
      });

      let stderr = "";

      child.stdout.on("data", (chunk: Buffer | string) => {
        const message = chunk.toString("utf8").trim();
        if (message) {
          this.log(`[mlx-env] ${message}`);
        }
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        const message = chunk.toString("utf8");
        stderr += message;
        const trimmed = message.trim();
        if (trimmed) {
          this.log(`[mlx-env] ${trimmed}`);
        }
      });
      child.on("error", (error) => {
        reject(new Error(`MD Audio could not ${action}: ${error.message}`));
      });
      child.on("exit", (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }

        reject(
          new Error(
            [
              `MD Audio could not ${action}.`,
              `Command: ${command} ${args.join(" ")}`,
              `Exit: code=${code ?? "null"}, signal=${signal ?? "null"}`,
              stderr.trim(),
            ]
              .filter(Boolean)
              .join(" "),
          ),
        );
      });
    });
  }
}

function isPlaybackStoppedError(error: unknown): boolean {
  return error instanceof Error && error.message === MLX_STOPPED_MESSAGE;
}

function buildWorkerFailureMessage(error: unknown, pythonPath: string): string {
  const detail = error instanceof Error ? error.message : String(error);
  return [
    `MD Audio could not start its managed MLX Kokoro worker with '${pythonPath}'.`,
    `Run MD Audio: Check Backend to reprovision the private environment, or set mdAudio.uvPath if MD Audio cannot find uv.`,
    detail,
  ]
    .join(" ")
    .trim();
}
