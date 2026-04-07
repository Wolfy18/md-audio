import test from "node:test";
import assert from "node:assert/strict";
import {
  SummaryPreparationController,
  summaryStatusText,
  summaryStatusTooltip,
} from "../summaryPreparation";

test("tracks summary preparation phases and clears them by token", () => {
  const controller = new SummaryPreparationController();
  const state = controller.start("file:///demo.md");

  assert.ok(state);
  assert.equal(state.phase, "loading_document");

  controller.advance(state.token, "building_summary");
  assert.equal(controller.current()?.phase, "building_summary");

  controller.finish(state.token);
  assert.equal(controller.current(), undefined);
});

test("suppresses duplicate summary preparation while one is active", () => {
  const controller = new SummaryPreparationController();
  const first = controller.start("file:///demo.md");
  const second = controller.start("file:///other.md");

  assert.ok(first);
  assert.equal(second, undefined);
  assert.equal(controller.isPreparing("file:///demo.md"), true);
  assert.equal(controller.isPreparing("file:///other.md"), false);
});

test("ignores stale phase updates after preparation is cleared", () => {
  const controller = new SummaryPreparationController();
  const first = controller.start("file:///demo.md");

  assert.ok(first);
  controller.finish(first.token);
  controller.advance(first.token, "starting_playback");

  assert.equal(controller.current(), undefined);
});

test("renders summary status text and tooltips for each loading phase", () => {
  const controller = new SummaryPreparationController();
  const state = controller.start("file:///demo.md");

  assert.ok(state);
  assert.equal(summaryStatusText(controller.current(), false), "$(sync~spin) Building Summary");
  assert.equal(summaryStatusTooltip(controller.current()), "Loading Markdown into the native summarizer");

  controller.advance(state.token, "building_summary");
  assert.equal(summaryStatusTooltip(controller.current()), "Parsing Markdown and building the developer summary");

  controller.advance(state.token, "preparing_backend");
  assert.equal(summaryStatusTooltip(controller.current()), "Preparing the playback backend for the summary");

  controller.advance(state.token, "starting_playback");
  assert.equal(summaryStatusTooltip(controller.current()), "Starting summary playback");

  controller.finish(state.token);
  assert.equal(summaryStatusText(controller.current(), false), "$(list-tree) Summary");
  assert.equal(summaryStatusText(controller.current(), true), "$(sync~spin) Summary");
});
