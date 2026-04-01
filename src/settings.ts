export interface ConfigurationReader {
  get<T>(section: string, defaultValue: T): T;
}

export interface MdAudioSettings {
  voice: string;
  rate: number;
  highlightCurrentUtterance: boolean;
  showEditorButtons: boolean;
  enabledLanguages: string[];
}

export function readSettings(configuration: ConfigurationReader): MdAudioSettings {
  return {
    voice: configuration.get("voice", "").trim(),
    rate: configuration.get("rate", 1),
    highlightCurrentUtterance: configuration.get("highlightCurrentUtterance", true),
    showEditorButtons: configuration.get("showEditorButtons", true),
    enabledLanguages: configuration.get("enabledLanguages", ["markdown"]).map((value) => value.trim()),
  };
}

