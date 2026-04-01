use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::sync::mpsc::{self, Sender};
use std::thread;

use anyhow::{Context, Result};
use md_audio_native::markdown::{Utterance, parse_markdown};
use md_audio_native::protocol::{Message, Request};
use md_audio_native::speech::{SpeechEngine, SpeechEvent};
use tts::UtteranceId;

#[derive(Clone, Debug)]
struct SpokenUtterance {
    document_id: String,
    utterance_index: usize,
    start_offset: usize,
    end_offset: usize,
    text: String,
}

struct AppState {
    speech: Option<SpeechEngine>,
    backend_error: Option<String>,
    documents: HashMap<String, Vec<Utterance>>,
    spoken: Vec<(String, SpokenUtterance)>,
}

impl AppState {
    fn new(event_sender: Sender<SpeechEvent>) -> Self {
        match SpeechEngine::new(event_sender) {
            Ok(speech) => Self {
                speech: Some(speech),
                backend_error: None,
                documents: HashMap::new(),
                spoken: Vec::new(),
            },
            Err(error) => Self {
                speech: None,
                backend_error: Some(error.to_string()),
                documents: HashMap::new(),
                spoken: Vec::new(),
            },
        }
    }

    fn handle_request(&mut self, request: Request) -> Message {
        match request {
            Request::Init { id } => {
                if let Some(error) = &self.backend_error {
                    Message::InitResult {
                        id,
                        available: false,
                        backend: "system-tts".to_string(),
                        message: Some(error.clone()),
                    }
                } else {
                    let features = self
                        .speech
                        .as_ref()
                        .map(|speech| format!("{:?}", speech.features()))
                        .unwrap_or_else(|| "unknown".to_string());

                    Message::InitResult {
                        id,
                        available: true,
                        backend: format!("system-tts ({features})"),
                        message: None,
                    }
                }
            }
            Request::ListVoices { id } => match self.with_speech_mut(|speech| speech.voices()) {
                Ok(voices) => Message::ListVoicesResult { id, voices },
                Err(error) => self.error_message(id, "list_voices_failed", error),
            },
            Request::LoadDocument {
                id,
                document_id,
                text,
            } => {
                let utterances = parse_markdown(&text);
                let utterance_count = utterances.len();
                self.documents.insert(document_id.clone(), utterances);
                Message::LoadDocumentResult {
                    id,
                    document_id,
                    utterance_count,
                }
            }
            Request::Speak {
                id,
                document_id,
                start_offset,
                end_offset,
                voice_id,
                rate,
            } => {
                let Some(utterances) = self.documents.get(&document_id).cloned() else {
                    return Message::ErrorResult {
                        id,
                        code: "document_not_loaded".to_string(),
                        message: format!("document '{document_id}' is not loaded"),
                    };
                };

                match self.queue_document(&document_id, &utterances, start_offset, end_offset, voice_id, rate)
                {
                    Ok(queued) => Message::SpeakResult {
                        id,
                        document_id,
                        queued,
                    },
                    Err(error) => self.error_message(id, "speak_failed", error),
                }
            }
            Request::Stop { id } => match self.with_speech_mut(|speech| speech.stop()) {
                Ok(()) => {
                    self.spoken.clear();
                    Message::StopResult { id }
                }
                Err(error) => self.error_message(id, "stop_failed", error),
            },
        }
    }

    fn handle_speech_event(&mut self, event: SpeechEvent) -> Option<Message> {
        match event {
            SpeechEvent::UtteranceBegin(utterance_id) => self
                .spoken
                .iter()
                .find(|(queued_id, _)| queued_id == &utterance_key(&utterance_id))
                .map(|(_, entry)| Message::UtteranceBegin {
                    document_id: entry.document_id.clone(),
                    utterance_index: entry.utterance_index,
                    start_offset: entry.start_offset,
                    end_offset: entry.end_offset,
                    text: entry.text.clone(),
                }),
            SpeechEvent::UtteranceEnd(utterance_id) => self
                .spoken
                .iter()
                .position(|(queued_id, _)| queued_id == &utterance_key(&utterance_id))
                .map(|index| self.spoken.remove(index).1)
                .map(|entry| Message::UtteranceEnd {
                    document_id: entry.document_id,
                    utterance_index: entry.utterance_index,
                    start_offset: entry.start_offset,
                    end_offset: entry.end_offset,
                    text: entry.text,
                }),
        }
    }

    fn queue_document(
        &mut self,
        document_id: &str,
        utterances: &[Utterance],
        start_offset: Option<usize>,
        end_offset: Option<usize>,
        voice_id: Option<String>,
        rate: f32,
    ) -> Result<usize> {
        let selected = select_utterances(utterances, start_offset, end_offset);
        if selected.is_empty() {
            return Ok(0);
        }

        self.spoken.clear();

        let speech = self
            .speech
            .as_mut()
            .context(self.backend_error.clone().unwrap_or_else(|| "system TTS backend is unavailable".to_string()))?;

        speech.configure(voice_id.as_deref(), rate)?;
        speech.stop()?;

        for (utterance_index, utterance) in selected.iter().enumerate() {
            let queued = speech.speak(&utterance.text, utterance_index == 0)?;
            if let Some(utterance_id) = queued {
                self.spoken.push((
                    utterance_key(&utterance_id),
                    SpokenUtterance {
                        document_id: document_id.to_string(),
                        utterance_index,
                        start_offset: utterance.start_offset,
                        end_offset: utterance.end_offset,
                        text: utterance.text.clone(),
                    },
                ));
            }
        }

        Ok(selected.len())
    }

    fn with_speech_mut<T>(
        &mut self,
        callback: impl FnOnce(&mut SpeechEngine) -> Result<T>,
    ) -> Result<T> {
        let speech = self
            .speech
            .as_mut()
            .context(self.backend_error.clone().unwrap_or_else(|| "system TTS backend is unavailable".to_string()))?;
        callback(speech)
    }

    fn error_message(&self, id: String, code: &str, error: anyhow::Error) -> Message {
        Message::ErrorResult {
            id,
            code: code.to_string(),
            message: error.to_string(),
        }
    }
}

fn utterance_key(utterance_id: &UtteranceId) -> String {
    format!("{utterance_id:?}")
}

fn main() -> Result<()> {
    let (request_sender, request_receiver) = mpsc::channel::<Request>();
    let (speech_sender, speech_receiver) = mpsc::channel::<SpeechEvent>();

    spawn_stdin_reader(request_sender);

    let mut app = AppState::new(speech_sender);
    let stdout = io::stdout();
    let mut writer = stdout.lock();

    loop {
        while let Ok(event) = speech_receiver.try_recv() {
            if let Some(message) = app.handle_speech_event(event) {
                write_message(&mut writer, &message)?;
            }
        }

        let request = match request_receiver.recv() {
            Ok(request) => request,
            Err(_) => break,
        };

        let message = app.handle_request(request);
        if let Message::InitResult {
            available: false,
            message: Some(error),
            ..
        } = &message
        {
            write_message(
                &mut writer,
                &Message::BackendUnavailable {
                    message: error.clone(),
                },
            )?;
        }
        write_message(&mut writer, &message)?;
    }

    Ok(())
}

fn spawn_stdin_reader(sender: Sender<Request>) {
    thread::spawn(move || {
        let stdin = io::stdin();
        let reader = io::BufReader::new(stdin.lock());

        for line in reader.lines() {
            let Ok(line) = line else {
                break;
            };

            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            if let Ok(request) = serde_json::from_str::<Request>(trimmed) {
                if sender.send(request).is_err() {
                    break;
                }
            }
        }
    });
}

fn write_message(writer: &mut impl Write, message: &Message) -> Result<()> {
    serde_json::to_writer(&mut *writer, message)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

fn select_utterances(
    utterances: &[Utterance],
    start_offset: Option<usize>,
    end_offset: Option<usize>,
) -> Vec<Utterance> {
    let start_offset = start_offset.unwrap_or(0);

    utterances
        .iter()
        .filter(|utterance| {
            if utterance.end_offset <= start_offset {
                return false;
            }

            if let Some(end_offset) = end_offset {
                utterance.start_offset < end_offset
            } else {
                true
            }
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::select_utterances;
    use md_audio_native::markdown::Utterance;

    #[test]
    fn selects_from_cursor_forward() {
        let utterances = vec![
            Utterance {
                text: "One".to_string(),
                start_offset: 0,
                end_offset: 4,
            },
            Utterance {
                text: "Two".to_string(),
                start_offset: 5,
                end_offset: 9,
            },
        ];

        let selected = select_utterances(&utterances, Some(4), None);
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].text, "Two");
    }

    #[test]
    fn selects_intersecting_ranges() {
        let utterances = vec![
            Utterance {
                text: "One".to_string(),
                start_offset: 0,
                end_offset: 4,
            },
            Utterance {
                text: "Two".to_string(),
                start_offset: 5,
                end_offset: 9,
            },
            Utterance {
                text: "Three".to_string(),
                start_offset: 10,
                end_offset: 16,
            },
        ];

        let selected = select_utterances(&utterances, Some(3), Some(11));
        assert_eq!(selected.len(), 3);
    }
}
