# MD Audio

MD Audio is a VS Code and Cursor extension that reads Markdown aloud offline through a Rust native parser, a local Kokoro MLX backend on Apple Silicon, and system TTS fallback elsewhere.

## Current scope

- Live read-aloud for the whole Markdown document, from the current cursor, or from the current selection
- Offline summary playback that turns a Markdown file into a clear developer-oriented summary and reads it aloud
- English and Spanish document support only
- Automatic English/Spanish document detection with configurable American English and Spanish Kokoro voices
- Local MLX/Kokoro playback on Apple Silicon with system TTS fallback
- MLX/Kokoro synthesis batches consecutive passages with stronger sentence pauses so playback sounds more natural
- Rust markdown parser connected to the extension host over JSON lines on stdio
- Highlighting for the currently spoken utterance during playback
- Status bar playback controls for document listen, summary listen, stop, and speed changes while reading

## Commands

- `MD Audio: Listen to Document`
- `MD Audio: Listen From Cursor`
- `MD Audio: Listen to Selection`
- `MD Audio: Listen to Summary`
- `MD Audio: Change Speed`
- `MD Audio: Stop`
- `MD Audio: Select Voice`
- `MD Audio: List Voices`
- `MD Audio: Check Backend`

`MD Audio: Select Voice` selects the system voice on the system backend, or lets you choose separate Kokoro voices for English and Spanish playback on the local MLX backend.

## Development

```bash
npm install
npm run build
npm test
npm run package:vsix
```

The native build uses a repo-local Cargo cache at `.cargo-home/` and compiles the Rust binary from `native/`.

## Local MLX setup

For the local-model path on Apple Silicon, MD Audio now creates a private MLX/Kokoro environment under the extension's global storage directory with `uv`. It no longer depends on the current repo's `.venv`.

```bash
brew install uv
```

If MD Audio cannot find `uv`, point `mdAudio.uvPath` at the `uv` executable you want it to use:

```json
{
  "mdAudio.backend": "mlx-kokoro",
  "mdAudio.uvPath": "/absolute/path/to/uv",
  "mdAudio.mlxModel": "mlx-community/Kokoro-82M-bf16"
}
```

After the first successful bootstrap, MD Audio always uses its managed interpreter from extension storage, regardless of which repo is open. `mdAudio.uvPath` is only an override when the machine's default `uv` installation is not the one you want MD Audio to use.

The extension uses a bundled Python worker to call `mlx-audio` directly, so you do not need `uvicorn` or the `mlx_audio.server` extras. The darwin-arm64 package also bundles the `espeak-ng` runtime required by Kokoro, so local playback does not require a separate `espeak-ng` install.

`MD Audio: Check Backend` will verify the MLX runtime and can trigger the first model load. The first successful check or listen may take longer because the selected model can be downloaded and loaded locally.

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

## Notes

Linux support depends on a system speech backend such as Speech Dispatcher when using the fallback system path.

The local MLX/Kokoro backend currently targets macOS on Apple Silicon and uses `afplay` for audio playback.
