import type { NativeUtteranceEvent } from "./protocol";

export interface HighlightTarget<TRange> {
  readonly documentId: string;
  createRange(startOffset: number, endOffset: number): TRange;
  apply(ranges: readonly TRange[]): void;
}

export class HighlightController<TRange> {
  show(
    target: HighlightTarget<TRange> | undefined,
    event: NativeUtteranceEvent,
    enabled: boolean,
  ): void {
    if (!enabled || !target || target.documentId !== event.document_id) {
      target?.apply([]);
      return;
    }

    const endOffset = Math.max(event.start_offset, event.end_offset);
    target.apply([target.createRange(event.start_offset, endOffset)]);
  }

  clear(target?: HighlightTarget<TRange>): void {
    target?.apply([]);
  }
}

