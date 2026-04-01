import * as vscode from "vscode";
import { HighlightController, type HighlightTarget } from "./highlightController";
import { NativeBridge } from "./nativeBridge";
import type { NativeUtteranceEvent } from "./protocol";
import { readSettings } from "./settings";

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
  const bridge = new NativeBridge({
    extensionPath: context.extensionPath,
    log: (message) => output.appendLine(message),
  });
  const highlight = new HighlightController<vscode.Range>();
  let lastHighlightedEditor: vscode.TextEditor | undefined;
  const removeNativeListener = bridge.onEvent((event) => {
    if (event.type === "backend_unavailable") {
      output.appendLine(event.message);
      void vscode.window.showWarningMessage(event.message);
      return;
    }

    handleUtteranceEvent(event);
  });

  let currentPlayback:
    | {
        documentId: string;
        remainingUtterances: number;
      }
    | undefined;

  const showError = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(message);
    void vscode.window.showErrorMessage(message);
  };

  const stopPlayback = async (notice?: string): Promise<void> => {
    try {
      await bridge.stop();
    } catch (error) {
      showError(error);
    } finally {
      currentPlayback = undefined;
      clearHighlight();
    }

    if (notice) {
      void vscode.window.showInformationMessage(notice);
    }
  };

  const getSettings = () => readSettings(vscode.workspace.getConfiguration("mdAudio"));

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

  const ensureBackendReady = async (): Promise<void> => {
    const result = await bridge.init();

    if (!result.available) {
      throw new Error(result.message ?? "The native speech backend is unavailable.");
    }
  };

  const buildSpeechSelection = (
    editor: vscode.TextEditor,
    mode: "document" | "from-cursor" | "selection",
  ): { startOffset?: number; endOffset?: number } => {
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

  const speak = async (mode: "document" | "from-cursor" | "selection"): Promise<void> => {
    const editor = ensureMarkdownEditor();
    const settings = getSettings();
    const selection = buildSpeechSelection(editor, mode);
    const documentId = editor.document.uri.toString();

    await ensureBackendReady();
    await bridge.loadDocument(documentId, editor.document.getText());
    const result = await bridge.speak({
      documentId,
      startOffset: selection.startOffset,
      endOffset: selection.endOffset,
      voiceId: settings.voice || undefined,
      rate: settings.rate,
    });

    currentPlayback = {
      documentId,
      remainingUtterances: result.queued,
    };

    if (result.queued === 0) {
      void vscode.window.showInformationMessage("Nothing speakable was found in the selected Markdown range.");
    }
  };

  const getHighlightTarget = (): VscodeHighlightTarget | undefined => {
    const editor = vscode.window.activeTextEditor;
    return editor ? new VscodeHighlightTarget(editor) : undefined;
  };

  const clearHighlight = (): void => {
    if (!lastHighlightedEditor) {
      return;
    }

    new VscodeHighlightTarget(lastHighlightedEditor).apply([]);
    lastHighlightedEditor = undefined;
  };

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
      return;
    }

    if (currentPlayback && currentPlayback.documentId === event.document_id) {
      currentPlayback.remainingUtterances = Math.max(0, currentPlayback.remainingUtterances - 1);
      if (currentPlayback.remainingUtterances === 0) {
        clearHighlight();
        currentPlayback = undefined;
      }
    }
  };

  context.subscriptions.push(
    output,
    decorationType,
    new vscode.Disposable(() => bridge.dispose()),
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
    vscode.commands.registerCommand("mdAudio.stop", async () => {
      await stopPlayback();
    }),
    vscode.commands.registerCommand("mdAudio.checkBackend", async () => {
      try {
        const result = await bridge.init();
        if (result.available) {
          void vscode.window.showInformationMessage(`MD Audio backend ready: ${result.backend}`);
          return;
        }

        throw new Error(result.message ?? "The native backend is unavailable.");
      } catch (error) {
        showError(error);
      }
    }),
    vscode.commands.registerCommand("mdAudio.listVoices", async () => {
      try {
        await ensureBackendReady();
        const { voices } = await bridge.listVoices();

        if (voices.length === 0) {
          void vscode.window.showInformationMessage("No system voices were reported by the native backend.");
          return;
        }

        output.appendLine("Available voices:");
        for (const voice of voices) {
          output.appendLine(
            `- ${voice.name} [${voice.id}] ${voice.locale ?? "unknown-locale"} ${voice.gender ?? ""}`.trim(),
          );
        }
        output.show(true);
      } catch (error) {
        showError(error);
      }
    }),
    vscode.commands.registerCommand("mdAudio.selectVoice", async () => {
      try {
        await ensureBackendReady();
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
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor || !currentPlayback || editor.document.uri.toString() !== currentPlayback.documentId) {
        clearHighlight();
      }
    }),
  );
}

export function deactivate(): void {
  decorationType.dispose();
}
