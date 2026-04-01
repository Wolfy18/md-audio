export interface NativeVoice {
  id: string;
  name: string;
  locale?: string;
  gender?: string;
}

export interface NativeUtteranceEvent {
  type: "utterance_begin" | "utterance_end";
  document_id: string;
  utterance_index: number;
  start_offset: number;
  end_offset: number;
  text: string;
}

export interface NativeBackendUnavailableEvent {
  type: "backend_unavailable";
  message: string;
}

export type NativeEvent = NativeUtteranceEvent | NativeBackendUnavailableEvent;

export interface InitResult {
  id: string;
  type: "init_result";
  available: boolean;
  backend: string;
  message?: string;
}

export interface ListVoicesResult {
  id: string;
  type: "list_voices_result";
  voices: NativeVoice[];
}

export interface LoadDocumentResult {
  id: string;
  type: "load_document_result";
  document_id: string;
  utterance_count: number;
}

export interface SpeakResult {
  id: string;
  type: "speak_result";
  document_id: string;
  queued: number;
}

export interface StopResult {
  id: string;
  type: "stop_result";
}

export interface ErrorResult {
  id: string;
  type: "error_result";
  code: string;
  message: string;
}

export type NativeResponse =
  | InitResult
  | ListVoicesResult
  | LoadDocumentResult
  | SpeakResult
  | StopResult
  | ErrorResult;

export interface InitRequest {
  id: string;
  type: "init";
}

export interface ListVoicesRequest {
  id: string;
  type: "list_voices";
}

export interface LoadDocumentRequest {
  id: string;
  type: "load_document";
  document_id: string;
  text: string;
}

export interface SpeakRequest {
  id: string;
  type: "speak";
  document_id: string;
  start_offset?: number;
  end_offset?: number;
  voice_id?: string;
  rate: number;
}

export interface StopRequest {
  id: string;
  type: "stop";
}

export type NativeRequest =
  | InitRequest
  | ListVoicesRequest
  | LoadDocumentRequest
  | SpeakRequest
  | StopRequest;

