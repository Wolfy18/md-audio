import * as vscode from "vscode";
import { HighlightController, type HighlightTarget } from "./highlightController";
import {
  batchPreparedUtterances,
  MLX_BACKEND_ID,
  MLX_FIXED_SPEAKER,
  MLX_STOPPED_MESSAGE,
  MlxBackend,
  resolveMlxVoice,
} from "./mlxBackend";
import { NativeBridge } from "./nativeBridge";
import type { NativeUtteranceEvent, NativeVoice, PreparedUtterance } from "./protocol";
import { readSettings, type MdAudioSettings } from "./settings";
import { SPEED_PRESETS, formatSpeed } from "./speed";

type ListenMode = "document" | "from-cursor" | "selection" | "summary";
type PlaybackBackend = "system" | typeof MLX_BACKEND_ID;

interface PlaybackSelection {
  startOffset?: number;
  endOffset?: number;
}

interface PlaybackState extends PlaybackSelection {
  token: number;
  backend: PlaybackBackend;
  mode: ListenMode;
  documentId: string;
  remainingUtterances: number;
  currentOffset?: number;
}

interface PreparedPlayback {
  languageCode?: string;
  utterances: PreparedUtterance[];
}

class VscodeHighlightTarget implements HighlightTarget<vscode.Range> {
  readonly documentId: string;

  constructor(private readonly editor: vscode.TextEditor) {
    this.documentId = editor.document.uri.toString();
  }

  createRange(startOffset: number, endOffset: number): vscode.Range {
    return new vscode.Range(
      this.editor.document.positionAt(startOffset),
      this.editor.document.positionAt(endOffset),
    );
  }

  apply(ranges: readonly vscode.Range[]): void {
    this.editor.setDecorations(decorationType, [...ranges]);
  }
}

const decorationType = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor("editor.wordHighlightStrongBackground"),
  borderRadius: "3px",
});

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("MD Audio");
  const listenStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 130);
  const speedStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 129);
  const stopStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 128);
  const bridge = new NativeBridge({
    extensionPath: context.extensionPath,
    log: (message) => output.appendLine(message),
  });
  const mlx = new MlxBackend({
    extensionPath: context.extensionPath,
    storagePath: context.globalStorageUri.fsPath,
    log: (message) => output.appendLine(message),
  });
  const highlight = new HighlightController<vscode.Range>();

  let lastHighlightedEditor: vscode.TextEditor | undefined;
  let currentPlayback: PlaybackState | undefined;
  let nextPlaybackToken = 0;

  const getSettings = () => readSettings(vscode.workspace.getConfiguration("mdAudio"));

  const showError = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(message);
    void vscode.window.showErrorMessage(message);
  };

  const clearHighlight = (): void => {
    if (!lastHighlightedEditor) {
      return;
    }

    new VscodeHighlightTarget(lastHighlightedEditor).apply([]);
    lastHighlightedEditor = undefined;
  };

  const isEligibleEditor = (editor: vscode.TextEditor | undefined): boolean => {
    if (!editor) {
      return false;
    }

    return getSettings().enabledLanguages.includes(editor.document.languageId);
  };

  const configuredPlaybackBackend = (settings: MdAudioSettings): PlaybackBackend => {
    if (settings.backend === "system" || settings.backend === MLX_BACKEND_ID) {
      return settings.backend;
    }

    return MlxBackend.isPreferredPlatform() ? MLX_BACKEND_ID : "system";
  };

  const updatePlaybackControls = (): void => {
    const activeEditor = vscode.window.activeTextEditor;
    const hasEligibleEditor = isEligibleEditor(activeEditor);
    const isActiveDocumentPlaying =
      !!currentPlayback && activeEditor?.document.uri.toString() === currentPlayback.documentId;
    const hasPlayback = !!currentPlayback;
    const settings = getSettings();

    listenStatusItem.text = isActiveDocumentPlaying ? "$(sync~spin) Listening" : "$(unmute) Listen";
    listenStatusItem.tooltip = "Listen to the current Markdown document";
    listenStatusItem.command = "mdAudio.speakDocument";

    speedStatusItem.text = `$(dashboard) ${formatSpeed(settings.rate)}`;
    speedStatusItem.tooltip = "Change MD Audio speed";
    speedStatusItem.command = "mdAudio.changeSpeed";

    stopStatusItem.text = "$(debug-stop) Stop";
    stopStatusItem.tooltip = "Stop MD Audio playback";
    stopStatusItem.command = "mdAudio.stop";

    if (hasEligibleEditor) {
      listenStatusItem.show();
    } else {
      listenStatusItem.hide();
    }

    if (hasEligibleEditor || hasPlayback) {
      speedStatusItem.show();
    } else {
      speedStatusItem.hide();
    }

    if (hasPlayback) {
      stopStatusItem.show();
    } else {
      stopStatusItem.hide();
    }
  };

  const ensureMarkdownEditor = (): vscode.TextEditor => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      throw new Error("Open a Markdown editor to use MD Audio.");
    }

    const settings = getSettings();
    if (!settings.enabledLanguages.includes(editor.document.languageId)) {
      throw new Error(
        `MD Audio is disabled for language '${editor.document.languageId}'. Update mdAudio.enabledLanguages to allow it.`,
      );
    }

    return editor;
  };

  const ensureSystemBackendReady = async (): Promise<void> => {
    const result = await bridge.init();
    if (!result.available) {
      throw new Error(result.message ?? "The native speech backend is unavailable.");
    }
  };

  const buildSpeechSelection = (
    editor: vscode.TextEditor,
    mode: ListenMode,
  ): PlaybackSelection => {
    if (mode === "document") {
      return {};
    }

    const selection = editor.selection;
    if (mode === "selection") {
      if (selection.isEmpty) {
        throw new Error("Select a Markdown range before using Listen to Selection.");
      }

      return {
        startOffset: editor.document.offsetAt(selection.start),
        endOffset: editor.document.offsetAt(selection.end),
      };
    }

    return {
      startOffset: editor.document.offsetAt(selection.active),
    };
  };

  const preparePlayback = async (
    document: vscode.TextDocument,
    selection: PlaybackSelection,
  ): Promise<PreparedPlayback> => {
    const documentId = document.uri.toString();
    await bridge.loadDocument(documentId, document.getText());

    const prepared = await bridge.prepareSpeech({
      documentId,
      startOffset: selection.startOffset,
      endOffset: selection.endOffset,
    });

    return {
      languageCode: prepared.language_code,
      utterances: prepared.utterances,
    };
  };

  const prepareSummaryPlayback = async (document: vscode.TextDocument): Promise<PreparedPlayback> => {
    const documentId = document.uri.toString();
    await bridge.loadDocument(documentId, document.getText());

    const prepared = await bridge.prepareSummary(documentId);
    return {
      languageCode: prepared.language_code,
      utterances: prepared.utterances,
    };
  };

  const emptyPlaybackMessage = (mode: ListenMode): string =>
    mode === "summary"
      ? "MD Audio could not build a summary for this Markdown file."
      : "Nothing speakable was found in the selected Markdown range.";

  const handleUtteranceEvent = (event: NativeUtteranceEvent): void => {
    const settings = getSettings();
    const editor = vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document.uri.toString() === event.document_id,
    );
    const target = editor ? new VscodeHighlightTarget(editor) : undefined;

    if (event.type === "utterance_begin") {
      if (
        lastHighlightedEditor &&
        lastHighlightedEditor.document.uri.toString() !== editor?.document.uri.toString()
      ) {
        clearHighlight();
      }

      highlight.show(target, event, settings.highlightCurrentUtterance);
      lastHighlightedEditor = editor;

      if (currentPlayback && currentPlayback.documentId === event.document_id) {
        currentPlayback.currentOffset = event.start_offset;
      }
      return;
    }

    if (currentPlayback && currentPlayback.documentId === event.document_id) {
      currentPlayback.remainingUtterances = Math.max(0, currentPlayback.remainingUtterances - 1);
      if (currentPlayback.remainingUtterances === 0) {
        clearHighlight();
        currentPlayback = undefined;
        updatePlaybackControls();
      }
    }
  };

  const handlePlaybackFinished = (token: number): void => {
    if (!currentPlayback || currentPlayback.token !== token) {
      return;
    }

    clearHighlight();
    currentPlayback = undefined;
    updatePlaybackControls();
  };

  const stopPlayback = async (notice?: string): Promise<void> => {
    const playback = currentPlayback;
    if (!playback) {
      clearHighlight();
      updatePlaybackControls();
      return;
    }

    try {
      if (playback.backend === MLX_BACKEND_ID) {
        await mlx.stop();
      } else if (playback.backend === "system") {
        await bridge.stop();
      }
    } catch (error) {
      showError(error);
    } finally {
      currentPlayback = undefined;
      clearHighlight();
      updatePlaybackControls();
    }

    if (notice) {
      void vscode.window.showInformationMessage(notice);
    }
  };

  const resolvePlaybackBackend = async (settings: MdAudioSettings): Promise<PlaybackBackend> => {
    if (settings.backend === "system") {
      return "system";
    }

        const mlxStatus = await mlx.check(settings, true);

    if (settings.backend === MLX_BACKEND_ID) {
      if (!mlxStatus.available) {
        throw new Error(mlxStatus.message ?? "The MLX/Kokoro backend is unavailable.");
      }

      return MLX_BACKEND_ID;
    }

    if (mlxStatus.available) {
      return MLX_BACKEND_ID;
    }

    output.appendLine(`MLX/Kokoro backend unavailable, falling back to system TTS: ${mlxStatus.message ?? "unknown error"}`);
    return "system";
  };

  const showPlaybackStartedNotice = async (
    rate: number,
    backend: PlaybackBackend,
    mode: ListenMode,
  ): Promise<void> => {
    const backendLabel =
      backend === MLX_BACKEND_ID
        ? `local Kokoro speaker ${MLX_FIXED_SPEAKER.name}`
        : "system voice";
    const action = await vscode.window.showInformationMessage(
      `MD Audio ${mode === "summary" ? "summary" : "playback"} started with ${backendLabel} at ${formatSpeed(rate)}.`,
      "Change Speed",
      "Stop",
    );

    if (action === "Change Speed") {
      await vscode.commands.executeCommand("mdAudio.changeSpeed");
    } else if (action === "Stop") {
      await stopPlayback();
    }
  };

  const startSystemPlayback = async (
    document: vscode.TextDocument,
    selection: PlaybackSelection,
    rate: number,
    settings: MdAudioSettings,
    mode: ListenMode,
    showNotice: boolean,
  ): Promise<void> => {
    const documentId = document.uri.toString();

    await bridge.loadDocument(documentId, document.getText());
    await ensureSystemBackendReady();

    const result =
      mode === "summary"
        ? await bridge.speakSummary({
            documentId,
            voiceId: settings.voice || undefined,
            rate,
          })
        : await bridge.speak({
            documentId,
            startOffset: selection.startOffset,
            endOffset: selection.endOffset,
            voiceId: settings.voice || undefined,
            rate,
          });

    if (result.queued === 0) {
      currentPlayback = undefined;
      clearHighlight();
      updatePlaybackControls();
      void vscode.window.showInformationMessage(emptyPlaybackMessage(mode));
      return;
    }

    currentPlayback = {
      token: ++nextPlaybackToken,
      backend: "system",
      mode,
      documentId,
      remainingUtterances: result.queued,
      startOffset: selection.startOffset,
      endOffset: selection.endOffset,
      currentOffset: selection.startOffset,
    };
    updatePlaybackControls();

    if (showNotice) {
      void showPlaybackStartedNotice(rate, "system", mode);
    }
  };

  const startMlxPlayback = async (
    document: vscode.TextDocument,
    selection: PlaybackSelection,
    prepared: PreparedPlayback,
    rate: number,
    settings: MdAudioSettings,
    mode: ListenMode,
    showNotice: boolean,
  ): Promise<void> => {
    if (prepared.utterances.length === 0) {
      currentPlayback = undefined;
      clearHighlight();
      updatePlaybackControls();
      void vscode.window.showInformationMessage(emptyPlaybackMessage(mode));
      return;
    }

    const batches = batchPreparedUtterances(prepared.utterances);
    const token = ++nextPlaybackToken;
    void mlx
      .playPrepared(
        settings,
        {
          documentId: document.uri.toString(),
          utterances: prepared.utterances,
          batches,
          languageCode: prepared.languageCode,
          rate,
        },
        handleUtteranceEvent,
      )
      .then(() => handlePlaybackFinished(token))
      .catch((error) => {
        handlePlaybackFinished(token);

        if (error instanceof Error && error.message === MLX_STOPPED_MESSAGE) {
          return;
        }

        showError(error);
      });

    currentPlayback = {
      token,
      backend: MLX_BACKEND_ID,
      mode,
      documentId: document.uri.toString(),
      remainingUtterances: batches.length,
      startOffset: selection.startOffset,
      endOffset: selection.endOffset,
      currentOffset: selection.startOffset,
    };
    updatePlaybackControls();

    if (showNotice) {
      void showPlaybackStartedNotice(rate, MLX_BACKEND_ID, mode);
    }
  };

  const startPlayback = async (
    document: vscode.TextDocument,
    selection: PlaybackSelection,
    rate: number,
    mode: ListenMode,
    showNotice: boolean,
  ): Promise<void> => {
    if (currentPlayback) {
      await stopPlayback();
    }

    const settings = getSettings();
    const backend = await resolvePlaybackBackend(settings);

    if (backend === MLX_BACKEND_ID) {
      const prepared =
        mode === "summary"
          ? await prepareSummaryPlayback(document)
          : await preparePlayback(document, selection);
      await startMlxPlayback(document, selection, prepared, rate, settings, mode, showNotice);
      return;
    }

    await startSystemPlayback(document, selection, rate, settings, mode, showNotice);
  };

  const speak = async (mode: ListenMode): Promise<void> => {
    const editor = ensureMarkdownEditor();
    const settings = getSettings();
    const selection = mode === "summary" ? {} : buildSpeechSelection(editor, mode);

    await startPlayback(editor.document, selection, settings.rate, mode, true);
  };

  const restartPlaybackWithNewSpeed = async (rate: number): Promise<void> => {
    const playback = currentPlayback;
    if (!playback) {
      return;
    }

    const document = vscode.workspace.textDocuments.find(
      (candidate) => candidate.uri.toString() === playback.documentId,
    );

    if (!document) {
      void vscode.window.showInformationMessage(
        `MD Audio speed set to ${formatSpeed(rate)}. It will apply the next time you start listening.`,
      );
      return;
    }

    if (playback.mode === "summary") {
      await startPlayback(document, {}, rate, "summary", false);
      return;
    }

    await startPlayback(
      document,
      {
        startOffset: playback.currentOffset ?? playback.startOffset,
        endOffset: playback.endOffset,
      },
      rate,
      playback.mode,
      false,
    );
  };

  const showVoiceList = (voices: readonly NativeVoice[], label: string): void => {
    if (voices.length === 0) {
      void vscode.window.showInformationMessage(`No ${label} voices were reported by the backend.`);
      return;
    }

    output.appendLine(`Available ${label} voices:`);
    for (const voice of voices) {
      output.appendLine(
        `- ${voice.name} [${voice.id}] ${voice.locale ?? "unknown-locale"} ${voice.gender ?? ""}`.trim(),
      );
    }
    output.show(true);
  };

  const showMlxVoicePicker = async (): Promise<void> => {
    const voice = resolveMlxVoice();
    await vscode.window.showInformationMessage(
      `MD Audio local Kokoro playback is locked to ${voice.name}.`,
    );
  };

  const removeNativeListener = bridge.onEvent((event) => {
    if (event.type === "backend_unavailable") {
      output.appendLine(event.message);
      return;
    }

    handleUtteranceEvent(event);
  });

  context.subscriptions.push(
    output,
    listenStatusItem,
    speedStatusItem,
    stopStatusItem,
    decorationType,
    new vscode.Disposable(() => bridge.dispose()),
    new vscode.Disposable(() => mlx.dispose()),
    new vscode.Disposable(() => removeNativeListener()),
    vscode.commands.registerCommand("mdAudio.speakDocument", async () => {
      try {
        await speak("document");
      } catch (error) {
        showError(error);
      }
    }),
    vscode.commands.registerCommand("mdAudio.speakFromCursor", async () => {
      try {
        await speak("from-cursor");
      } catch (error) {
        showError(error);
      }
    }),
    vscode.commands.registerCommand("mdAudio.speakSelection", async () => {
      try {
        await speak("selection");
      } catch (error) {
        showError(error);
      }
    }),
    vscode.commands.registerCommand("mdAudio.speakSummary", async () => {
      try {
        await speak("summary");
      } catch (error) {
        showError(error);
      }
    }),
    vscode.commands.registerCommand("mdAudio.stop", async () => {
      await stopPlayback();
    }),
    vscode.commands.registerCommand("mdAudio.changeSpeed", async () => {
      try {
        const settings = getSettings();
        const selected = await vscode.window.showQuickPick(
          SPEED_PRESETS.map((value) => ({
            label: formatSpeed(value),
            description: value === 1 ? "Normal" : value < 1 ? "Slower" : "Faster",
            detail: value === settings.rate ? "Current speed" : undefined,
            value,
          })),
          {
            title: "Choose MD Audio playback speed",
          },
        );

        if (!selected) {
          return;
        }

        await vscode.workspace
          .getConfiguration("mdAudio")
          .update("rate", selected.value, vscode.ConfigurationTarget.Global);

        if (currentPlayback) {
          await restartPlaybackWithNewSpeed(selected.value);
          void vscode.window.showInformationMessage(`MD Audio speed changed to ${selected.label}.`);
        } else {
          void vscode.window.showInformationMessage(`MD Audio speed set to ${selected.label}.`);
        }

        updatePlaybackControls();
      } catch (error) {
        showError(error);
      }
    }),
    vscode.commands.registerCommand("mdAudio.checkBackend", async () => {
      try {
        const settings = getSettings();
        const systemStatus = await bridge.init();
        const mlxStatus = await mlx.check(settings, true);

        if (settings.backend === "system") {
          if (!systemStatus.available) {
            throw new Error(systemStatus.message ?? "The system TTS backend is unavailable.");
          }

          void vscode.window.showInformationMessage(`MD Audio backend ready: ${systemStatus.backend}`);
          return;
        }

        if (settings.backend === MLX_BACKEND_ID) {
          if (!mlxStatus.available) {
            throw new Error(mlxStatus.message ?? "The MLX/Kokoro backend is unavailable.");
          }

          void vscode.window.showInformationMessage(`MD Audio backend ready: ${mlxStatus.backend}`);
          return;
        }

        if (mlxStatus.available) {
          void vscode.window.showInformationMessage(`MD Audio backend ready: ${mlxStatus.backend}`);
          return;
        }

        if (systemStatus.available) {
          void vscode.window.showWarningMessage(
            `MLX/Kokoro is unavailable, but MD Audio can fall back to ${systemStatus.backend}. ${mlxStatus.message ?? ""}`.trim(),
          );
          return;
        }

        throw new Error(
          [
            mlxStatus.message ?? "The MLX/Kokoro backend is unavailable.",
            systemStatus.message ?? "The system backend is unavailable.",
          ].join("\n"),
        );
      } catch (error) {
        showError(error);
      }
    }),
    vscode.commands.registerCommand("mdAudio.listVoices", async () => {
      try {
        const settings = getSettings();
        const backend = configuredPlaybackBackend(settings);

        if (backend === MLX_BACKEND_ID) {
          showVoiceList(mlx.listVoices(), "local Kokoro");
          return;
        }

        await ensureSystemBackendReady();
        const { voices } = await bridge.listVoices();
        showVoiceList(voices, "system");
      } catch (error) {
        showError(error);
      }
    }),
    vscode.commands.registerCommand("mdAudio.selectVoice", async () => {
      try {
        const settings = getSettings();
        const backend = configuredPlaybackBackend(settings);

        if (backend === MLX_BACKEND_ID) {
          await showMlxVoicePicker();
          return;
        }

        await ensureSystemBackendReady();
        const { voices } = await bridge.listVoices();

        if (voices.length === 0) {
          void vscode.window.showInformationMessage("No system voices were reported by the native backend.");
          return;
        }

        const selected = await vscode.window.showQuickPick(
          voices.map((voice) => ({
            label: voice.name,
            description: voice.locale ?? voice.id,
            detail: [voice.id, voice.gender].filter(Boolean).join(" | "),
            voiceId: voice.id,
          })),
          {
            title: "Select the system voice for MD Audio",
          },
        );

        if (!selected) {
          return;
        }

        await vscode.workspace
          .getConfiguration("mdAudio")
          .update("voice", selected.voiceId, vscode.ConfigurationTarget.Global);

        void vscode.window.showInformationMessage(`MD Audio voice set to ${selected.label}.`);
      } catch (error) {
        showError(error);
      }
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (currentPlayback && event.document.uri.toString() === currentPlayback.documentId) {
        void stopPlayback("Markdown changed while speaking. Playback stopped.");
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("mdAudio")) {
        updatePlaybackControls();
      }
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor || !currentPlayback || editor.document.uri.toString() !== currentPlayback.documentId) {
        clearHighlight();
      }

      updatePlaybackControls();
    }),
  );

  updatePlaybackControls();
}

export function deactivate(): void {
  decorationType.dispose();
}
