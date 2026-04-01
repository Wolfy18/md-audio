# MD Audio

MD Audio is a VS Code and Cursor extension that reads Markdown aloud offline through a Rust native binary and your operating system's built-in voices.

## Current scope

- Live read-aloud for the whole Markdown document, from the current cursor, or from the current selection
- Offline-first system TTS backend, no API key required
- Rust markdown parser and speech backend connected to the extension host over JSON lines on stdio
- Highlighting for the currently spoken utterance when the backend emits utterance callbacks

## Commands

- `MD Audio: Listen to Document`
- `MD Audio: Listen From Cursor`
- `MD Audio: Listen to Selection`
- `MD Audio: Stop`
- `MD Audio: Select Voice`
- `MD Audio: List Voices`
- `MD Audio: Check Backend`

## Development

```bash
npm install
npm run build
npm test
npm run package:vsix
```

The native build uses a repo-local Cargo cache at `.cargo-home/` and compiles the Rust binary from `native/`.

## Packaging

For local installs in Cursor or VS Code:

```bash
npm run build
npm run package:vsix
```

Then install the generated `.vsix` in the editor.

To package a non-host target, set `MD_AUDIO_TARGET` before running the package script. Example:

```bash
MD_AUDIO_TARGET=x86_64-unknown-linux-gnu npm run package:vsix
```

## Linux note

Linux support depends on a system speech backend such as Speech Dispatcher. If the backend is missing, `MD Audio: Check Backend` will report the native error instead of failing silently.
