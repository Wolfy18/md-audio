import test from "node:test";
import assert from "node:assert/strict";
import { HighlightController, type HighlightTarget } from "../highlightController";

class FakeTarget implements HighlightTarget<string> {
  readonly documentId = "file:///demo.md";
  ranges: readonly string[] = [];

  createRange(startOffset: number, endOffset: number): string {
    return `${startOffset}-${endOffset}`;
  }

  apply(ranges: readonly string[]): void {
    this.ranges = ranges;
  }
}

test("applies a highlight when the document matches", () => {
  const controller = new HighlightController<string>();
  const target = new FakeTarget();

  controller.show(
    target,
    {
      type: "utterance_begin",
      document_id: "file:///demo.md",
      utterance_index: 0,
      start_offset: 2,
      end_offset: 8,
      text: "hello",
    },
    true,
  );

  assert.deepEqual(target.ranges, ["2-8"]);
});

test("clears highlights when disabled", () => {
  const controller = new HighlightController<string>();
  const target = new FakeTarget();

  controller.show(
    target,
    {
      type: "utterance_begin",
      document_id: "file:///demo.md",
      utterance_index: 0,
      start_offset: 2,
      end_offset: 8,
      text: "hello",
    },
    false,
  );

  assert.deepEqual(target.ranges, []);
});

