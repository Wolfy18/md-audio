import { DEFAULT_SPEED, clampSpeed } from "./speed";

export interface ConfigurationReader {
  get<T>(section: string, defaultValue: T): T;
}

export interface MdAudioSettings {
  backend: "auto" | "system" | "mlx-kokoro";
  voice: string;
  mlxEnglishVoice: string;
  mlxSpanishVoice: string;
  rate: number;
  highlightCurrentUtterance: boolean;
  showEditorButtons: boolean;
  enabledLanguages: string[];
  uvPath: string;
  mlxModel: string;
}

export function readSettings(configuration: ConfigurationReader): MdAudioSettings {
  return {
    backend: normalizeBackend(configuration.get("backend", "auto")),
    voice: configuration.get("voice", "").trim(),
    mlxEnglishVoice: configuration.get("mlxEnglishVoice", "").trim(),
    mlxSpanishVoice: configuration.get("mlxSpanishVoice", "").trim(),
    rate: clampSpeed(configuration.get("rate", DEFAULT_SPEED)),
    highlightCurrentUtterance: configuration.get("highlightCurrentUtterance", true),
    showEditorButtons: configuration.get("showEditorButtons", true),
    enabledLanguages: configuration.get("enabledLanguages", ["markdown"]).map((value) => value.trim()),
    uvPath: configuration.get("uvPath", "").trim(),
    mlxModel: configuration.get("mlxModel", "mlx-community/Kokoro-82M-bf16").trim() || "mlx-community/Kokoro-82M-bf16",
  };
}

function normalizeBackend(value: string): MdAudioSettings["backend"] {
  if (value === "system" || value === "mlx-kokoro") {
    return value;
  }

  if (value === "mlx-qwen") {
    return "mlx-kokoro";
  }

  return "auto";
}
