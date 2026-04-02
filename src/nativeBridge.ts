import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { resolveNativeBinaryPath } from "./platform";
import type {
  ErrorResult,
  InitResult,
  ListVoicesResult,
  LoadDocumentResult,
  NativeEvent,
  NativeRequest,
  NativeResponse,
  PrepareSpeechResult,
  PrepareSummaryResult,
  SpeakResult,
  StopResult,
} from "./protocol";

export interface NativeBridgeOptions {
  extensionPath: string;
  log?: (message: string) => void;
  spawnProcess?: (command: string, args: readonly string[]) => ChildProcessWithoutNullStreams;
  binaryResolver?: (extensionPath: string) => string;
}

interface PendingRequest<TResponse extends NativeResponse> {
  resolve: (value: TResponse) => void;
  reject: (reason: Error) => void;
}

export class NativeBridge {
  private readonly events = new EventEmitter();
  private readonly pending = new Map<string, PendingRequest<NativeResponse>>();
  private readonly spawnProcess;
  private readonly binaryResolver;
  private readonly extensionPath: string;
  private readonly log: (message: string) => void;
  private process?: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private stdoutBuffer = "";
  private initPromise?: Promise<InitResult>;

  constructor(options: NativeBridgeOptions) {
    this.extensionPath = options.extensionPath;
    this.log = options.log ?? (() => undefined);
    this.spawnProcess = options.spawnProcess ?? ((command, args) => spawn(command, [...args]));
    this.binaryResolver = options.binaryResolver ?? resolveNativeBinaryPath;
  }

  onEvent(listener: (event: NativeEvent) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  async init(): Promise<InitResult> {
    this.initPromise ??= this.send<InitResult>({ type: "init" });
    return this.initPromise;
  }

  listVoices(): Promise<ListVoicesResult> {
    return this.send<ListVoicesResult>({ type: "list_voices" });
  }

  loadDocument(documentId: string, text: string): Promise<LoadDocumentResult> {
    return this.send<LoadDocumentResult>({
      type: "load_document",
      document_id: documentId,
      text,
    });
  }

  prepareSpeech(payload: {
    documentId: string;
    startOffset?: number;
    endOffset?: number;
  }): Promise<PrepareSpeechResult> {
    return this.send<PrepareSpeechResult>({
      type: "prepare_speech",
      document_id: payload.documentId,
      start_offset: payload.startOffset,
      end_offset: payload.endOffset,
    });
  }

  prepareSummary(documentId: string): Promise<PrepareSummaryResult> {
    return this.send<PrepareSummaryResult>({
      type: "prepare_summary",
      document_id: documentId,
    });
  }

  speak(payload: {
    documentId: string;
    startOffset?: number;
    endOffset?: number;
    voiceId?: string;
    rate: number;
  }): Promise<SpeakResult> {
    return this.send<SpeakResult>({
      type: "speak",
      document_id: payload.documentId,
      start_offset: payload.startOffset,
      end_offset: payload.endOffset,
      voice_id: payload.voiceId,
      rate: payload.rate,
    });
  }

  speakSummary(payload: {
    documentId: string;
    voiceId?: string;
    rate: number;
  }): Promise<SpeakResult> {
    return this.send<SpeakResult>({
      type: "speak_summary",
      document_id: payload.documentId,
      voice_id: payload.voiceId,
      rate: payload.rate,
    });
  }

  stop(): Promise<StopResult> {
    return this.send<StopResult>({ type: "stop" });
  }

  dispose(): void {
    this.initPromise = undefined;
    this.stdoutBuffer = "";

    for (const [, pending] of this.pending) {
      pending.reject(new Error("Native bridge disposed before a response was received."));
    }
    this.pending.clear();

    this.process?.kill();
    this.process = undefined;
    this.events.removeAllListeners();
  }

  private async ensureStarted(): Promise<ChildProcessWithoutNullStreams> {
    if (this.process) {
      return this.process;
    }

    const binaryPath = this.binaryResolver(this.extensionPath);
    await access(binaryPath, fsConstants.X_OK);

    const child = this.spawnProcess(binaryPath, []);
    this.process = child;

    child.stdout.on("data", (chunk: Buffer | string) => {
      this.handleStdout(chunk.toString("utf8"));
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      this.log(chunk.toString("utf8").trimEnd());
    });

    child.on("exit", (code, signal) => {
      const reason = `Native process exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`;
      this.log(reason);
      this.process = undefined;
      this.initPromise = undefined;

      for (const [, pending] of this.pending) {
        pending.reject(new Error(reason));
      }
      this.pending.clear();
    });

    child.on("error", (error) => {
      this.log(`Native process error: ${error.message}`);
    });

    return child;
  }

  private async send<TResponse extends NativeResponse>(
    message: { type: NativeRequest["type"] } & Record<string, unknown>,
  ): Promise<TResponse> {
    const child = await this.ensureStarted();
    const id = `${++this.nextId}`;
    const request = { ...message, id } as NativeRequest;

    const promise = new Promise<TResponse>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: NativeResponse) => void,
        reject,
      });
    });

    child.stdin.write(`${JSON.stringify(request)}\n`, "utf8");
    return promise;
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      this.handleMessage(trimmed);
    }
  }

  private handleMessage(raw: string): void {
    let parsed: NativeResponse | NativeEvent;

    try {
      parsed = JSON.parse(raw) as NativeResponse | NativeEvent;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Failed to parse native message: ${message}`);
      return;
    }

    if ("id" in parsed) {
      const pending = this.pending.get(parsed.id);
      if (!pending) {
        return;
      }

      this.pending.delete(parsed.id);

      if (parsed.type === "error_result") {
        const error = parsed as ErrorResult;
        pending.reject(new Error(`${error.code}: ${error.message}`));
        return;
      }

      pending.resolve(parsed as NativeResponse);
      return;
    }

    this.events.emit("event", parsed);
  }
}
