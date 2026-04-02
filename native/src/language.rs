use std::sync::OnceLock;

use whatlang::{Detector, Lang};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SupportedLanguage {
    English,
    Spanish,
}

impl SupportedLanguage {
    pub fn code(self) -> &'static str {
        match self {
            SupportedLanguage::English => "en",
            SupportedLanguage::Spanish => "es",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            SupportedLanguage::English => "english",
            SupportedLanguage::Spanish => "spanish",
        }
    }

    pub fn from_locale(locale: &str) -> Option<Self> {
        let prefix = locale
            .split(['-', '_'])
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();

        match prefix.as_str() {
            "en" => Some(SupportedLanguage::English),
            "es" => Some(SupportedLanguage::Spanish),
            _ => None,
        }
    }
}

pub fn detect_supported_language(text: &str) -> Option<SupportedLanguage> {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");

    if normalized.chars().filter(|character| character.is_alphabetic()).count() < 20 {
        return None;
    }

    let detector = DETECTOR.get_or_init(|| Detector::with_allowlist(vec![Lang::Eng, Lang::Spa]));
    detector.detect_lang(&normalized).and_then(|language| match language {
        Lang::Eng => Some(SupportedLanguage::English),
        Lang::Spa => Some(SupportedLanguage::Spanish),
        _ => None,
    })
}

static DETECTOR: OnceLock<Detector> = OnceLock::new();

#[cfg(test)]
mod tests {
    use super::{SupportedLanguage, detect_supported_language};

    #[test]
    fn detects_english_text() {
        let text = "This markdown document explains how the extension works and should clearly be recognized as English content for the reader.";
        assert_eq!(detect_supported_language(text), Some(SupportedLanguage::English));
    }

    #[test]
    fn detects_spanish_text() {
        let text = "Este documento de ejemplo explica como funciona la extension y deberia reconocerse claramente como contenido en espanol para el lector.";
        assert_eq!(detect_supported_language(text), Some(SupportedLanguage::Spanish));
    }

    #[test]
    fn ignores_too_short_text() {
        assert_eq!(detect_supported_language("hola"), None);
    }

    #[test]
    fn extracts_supported_languages_from_locale() {
        assert_eq!(SupportedLanguage::from_locale("en-US"), Some(SupportedLanguage::English));
        assert_eq!(SupportedLanguage::from_locale("es_MX"), Some(SupportedLanguage::Spanish));
        assert_eq!(SupportedLanguage::from_locale("fr-FR"), None);
    }
}
