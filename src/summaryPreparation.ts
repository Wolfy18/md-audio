export type SummaryPreparationPhase =
  | "loading_document"
  | "building_summary"
  | "preparing_backend"
  | "starting_playback";

export interface SummaryPreparationState {
  token: number;
  documentId: string;
  phase: SummaryPreparationPhase;
}

export class SummaryPreparationController {
  private state?: SummaryPreparationState;
  private nextToken = 0;

  start(documentId: string): SummaryPreparationState | undefined {
    if (this.state) {
      return undefined;
    }

    this.state = {
      token: ++this.nextToken,
      documentId,
      phase: "loading_document",
    };

    return { ...this.state };
  }

  advance(token: number, phase: SummaryPreparationPhase): void {
    if (!this.state || this.state.token !== token) {
      return;
    }

    this.state = {
      ...this.state,
      phase,
    };
  }

  finish(token?: number): void {
    if (!this.state) {
      return;
    }

    if (token !== undefined && this.state.token !== token) {
      return;
    }

    this.state = undefined;
  }

  isActive(token: number): boolean {
    return this.state?.token === token;
  }

  current(): SummaryPreparationState | undefined {
    return this.state ? { ...this.state } : undefined;
  }

  isPreparing(documentId?: string): boolean {
    if (!this.state) {
      return false;
    }

    return documentId ? this.state.documentId === documentId : true;
  }
}

export function summaryStatusText(state: SummaryPreparationState | undefined, isPlaying: boolean): string {
  if (isPlaying) {
    return "$(sync~spin) Summary";
  }

  if (state) {
    return "$(sync~spin) Building Summary";
  }

  return "$(list-tree) Summary";
}

export function summaryStatusTooltip(state: SummaryPreparationState | undefined): string {
  if (!state) {
    return "Listen to a summary of the current Markdown document";
  }

  switch (state.phase) {
    case "loading_document":
      return "Loading Markdown into the native summarizer";
    case "building_summary":
      return "Parsing Markdown and building the developer summary";
    case "preparing_backend":
      return "Preparing the playback backend for the summary";
    case "starting_playback":
      return "Starting summary playback";
  }
}
