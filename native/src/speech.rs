use std::sync::mpsc::Sender;

use anyhow::{Context, Result, anyhow};
use tts::{Features, Tts, UtteranceId, Voice};

use crate::language::SupportedLanguage;
use crate::protocol::VoiceInfo;

#[derive(Debug)]
pub enum SpeechEvent {
    UtteranceBegin(UtteranceId),
    UtteranceEnd(UtteranceId),
}

pub struct SpeechEngine {
    tts: Tts,
}

impl SpeechEngine {
    pub fn new(sender: Sender<SpeechEvent>) -> Result<Self> {
        let tts = Tts::default().context("failed to initialize system TTS")?;

        {
            let begin_sender = sender.clone();
            tts.on_utterance_begin(Some(Box::new(move |utterance_id| {
                let _ = begin_sender.send(SpeechEvent::UtteranceBegin(utterance_id));
            })))
            .context("failed to install utterance begin callback")?;
        }

        {
            let end_sender = sender;
            tts.on_utterance_end(Some(Box::new(move |utterance_id| {
                let _ = end_sender.send(SpeechEvent::UtteranceEnd(utterance_id));
            })))
            .context("failed to install utterance end callback")?;
        }

        Ok(Self { tts })
    }

    pub fn features(&self) -> Features {
        self.tts.supported_features()
    }

    pub fn voices(&mut self) -> Result<Vec<VoiceInfo>> {
        let voices = self.supported_voices()?;

        Ok(voices
            .into_iter()
            .map(|voice| VoiceInfo {
                id: voice.id(),
                name: voice.name().to_string(),
                locale: Some(voice.language().to_string()),
                gender: voice.gender().map(|value| format!("{value:?}")),
            })
            .collect())
    }

    pub fn configure(
        &mut self,
        voice_id: Option<&str>,
        language: Option<SupportedLanguage>,
        rate: f32,
    ) -> Result<()> {
        let backend_rate =
            map_speed_to_backend_rate(self.tts.min_rate(), self.tts.normal_rate(), self.tts.max_rate(), rate);
        self.tts
            .set_rate(backend_rate)
            .context("failed to set speech rate")?;

        let voices = self.supported_voices()?;
        let selected_voice_index = resolve_voice_index(&voices, voice_id, language);

        if let Some(voice_index) = selected_voice_index {
            self.tts
                .set_voice(&voices[voice_index])
                .context("failed to set voice")?;
        } else if !voices.is_empty() {
            self.tts
                .set_voice(&voices[0])
                .context("failed to set fallback voice")?;
        } else {
            return Err(anyhow!("no supported English or Spanish system voices were found"));
        }

        Ok(())
    }

    pub fn speak(&mut self, text: &str, interrupt: bool) -> Result<Option<UtteranceId>> {
        self.tts
            .speak(text, interrupt)
            .context("failed to queue speech")
    }

    pub fn is_speaking(&self) -> Result<bool> {
        let features = self.tts.supported_features();
        if features.is_speaking {
            self.tts
                .is_speaking()
                .context("failed to query speaking state")
        } else {
            Ok(false)
        }
    }

    pub fn stop(&mut self) -> Result<()> {
        self.tts.stop().context("failed to stop speech")?;
        Ok(())
    }

    fn supported_voices(&mut self) -> Result<Vec<Voice>> {
        let mut voices: Vec<_> = self
            .tts
            .voices()
            .context("failed to enumerate system voices")?
            .into_iter()
            .filter(|voice| {
                let locale = voice.language().to_string();
                SupportedLanguage::from_locale(&locale).is_some()
            })
            .collect();

        voices.sort_by(|left, right| {
            voice_priority(right, None)
                .cmp(&voice_priority(left, None))
                .then_with(|| left.language().to_string().cmp(&right.language().to_string()))
                .then_with(|| left.name().cmp(&right.name()))
        });

        Ok(voices)
    }
}

fn resolve_voice_index(
    voices: &[Voice],
    preferred_voice_id: Option<&str>,
    preferred_language: Option<SupportedLanguage>,
) -> Option<usize> {
    if let Some(voice_id) = preferred_voice_id {
        if let Some(index) = voices.iter().position(|voice| {
            voice.id() == voice_id
                && preferred_language.is_none_or(|language| {
                    language_matches_voice(language, voice)
                })
        }) {
            return Some(index);
        }
    }

    let mut best_index = None;
    let mut best_score = i32::MIN;

    for (index, voice) in voices.iter().enumerate() {
        if preferred_language.is_some_and(|language| !language_matches_voice(language, voice)) {
            continue;
        }

        let score = voice_priority(voice, preferred_language);
        if score > best_score {
            best_score = score;
            best_index = Some(index);
        }
    }

    best_index
}

fn language_matches_voice(language: SupportedLanguage, voice: &Voice) -> bool {
    SupportedLanguage::from_locale(&voice.language().to_string()) == Some(language)
}

fn voice_priority(voice: &Voice, preferred_language: Option<SupportedLanguage>) -> i32 {
    let voice_id = voice.id().to_ascii_lowercase();
    let locale = voice.language().to_string();
    let mut score = 0;

    if let Some(language) = preferred_language {
        if SupportedLanguage::from_locale(&locale) == Some(language) {
            score += 1_000;
        }
    }

    if voice_id.contains("ttsbundle.siri") {
        score += 300;
    }
    if voice_id.contains(".voice.compact.") {
        score += 250;
    }
    if voice.gender().is_some() {
        score += 100;
    }
    if voice_id.contains(".eloquence.") {
        score -= 100;
    }
    if voice_id.contains("speech.synthesis.voice.") {
        score -= 200;
    }

    score
}

fn map_speed_to_backend_rate(min_rate: f32, normal_rate: f32, max_rate: f32, speed: f32) -> f32 {
    let clamped_speed = speed.clamp(0.5, 2.0);

    if clamped_speed <= 1.0 {
        let fraction = (clamped_speed - 0.5) / 0.5;
        min_rate + (normal_rate - min_rate) * fraction
    } else {
        let fraction = clamped_speed - 1.0;
        normal_rate + (max_rate - normal_rate) * fraction
    }
}

#[cfg(test)]
mod tests {
    use super::map_speed_to_backend_rate;

    #[test]
    fn maps_normal_speed_to_backend_normal() {
        let mapped = map_speed_to_backend_rate(0.1, 0.5, 2.0, 1.0);
        assert!((mapped - 0.5).abs() < f32::EPSILON);
    }

    #[test]
    fn maps_half_speed_to_backend_minimum() {
        let mapped = map_speed_to_backend_rate(0.1, 0.5, 2.0, 0.5);
        assert!((mapped - 0.1).abs() < f32::EPSILON);
    }

    #[test]
    fn maps_faster_speed_above_normal() {
        let mapped = map_speed_to_backend_rate(0.1, 0.5, 2.0, 1.25);
        assert!((mapped - 0.875).abs() < 0.001);
    }
}
