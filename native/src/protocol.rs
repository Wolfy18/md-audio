use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Request {
    Init {
        id: String,
    },
    ListVoices {
        id: String,
    },
    LoadDocument {
        id: String,
        document_id: String,
        text: String,
    },
    Speak {
        id: String,
        document_id: String,
        start_offset: Option<usize>,
        end_offset: Option<usize>,
        voice_id: Option<String>,
        rate: f32,
    },
    Stop {
        id: String,
    },
}

#[derive(Clone, Debug, Serialize)]
pub struct VoiceInfo {
    pub id: String,
    pub name: String,
    pub locale: Option<String>,
    pub gender: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Message {
    InitResult {
        id: String,
        available: bool,
        backend: String,
        message: Option<String>,
    },
    ListVoicesResult {
        id: String,
        voices: Vec<VoiceInfo>,
    },
    LoadDocumentResult {
        id: String,
        document_id: String,
        utterance_count: usize,
    },
    SpeakResult {
        id: String,
        document_id: String,
        queued: usize,
    },
    StopResult {
        id: String,
    },
    ErrorResult {
        id: String,
        code: String,
        message: String,
    },
    UtteranceBegin {
        document_id: String,
        utterance_index: usize,
        start_offset: usize,
        end_offset: usize,
        text: String,
    },
    UtteranceEnd {
        document_id: String,
        utterance_index: usize,
        start_offset: usize,
        end_offset: usize,
        text: String,
    },
    BackendUnavailable {
        message: String,
    },
}
