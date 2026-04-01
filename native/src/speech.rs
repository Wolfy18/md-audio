use std::sync::mpsc::Sender;

use anyhow::{Context, Result, anyhow};
use tts::{Features, Tts, UtteranceId};

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
        let voices = self.tts.voices().context("failed to enumerate system voices")?;

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

    pub fn configure(&mut self, voice_id: Option<&str>, rate: f32) -> Result<()> {
        self.tts.set_rate(rate).context("failed to set speech rate")?;

        if let Some(voice_id) = voice_id {
            let voice = self
                .tts
                .voices()
                .context("failed to enumerate system voices")?
                .into_iter()
                .find(|voice| voice.id() == voice_id)
                .ok_or_else(|| anyhow!("voice with id '{voice_id}' was not found"))?;

            self.tts.set_voice(&voice).context("failed to set voice")?;
        }

        Ok(())
    }

    pub fn speak(&mut self, text: &str, interrupt: bool) -> Result<Option<UtteranceId>> {
        self.tts
            .speak(text, interrupt)
            .context("failed to queue speech")
    }

    pub fn stop(&mut self) -> Result<()> {
        self.tts.stop().context("failed to stop speech")?;
        Ok(())
    }
}
