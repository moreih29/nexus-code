import { expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RecordControls } from "../../../../../src/renderer/components/notes/record-controls";
import * as availability from "../../../../../src/renderer/services/voice/availability";

test("the signed-out recording button stays enabled and explains how to record", () => {
  const state = spyOn(availability, "useVoiceAvailability").mockReturnValue("signed-out");
  try {
    const html = renderToStaticMarkup(
      <RecordControls workspaceId="workspace" noteId="note" onStart={() => {}} />,
    );
    expect(html).toContain('data-testid="note-record"');
    expect(html).toContain('title="Sign in to record"');
    expect(html).not.toContain('disabled=""');
  } finally {
    state.mockRestore();
  }
});

test("next to the recording button, tells what happens once it ends", () => {
  const state = spyOn(availability, "useVoiceAvailability").mockReturnValue("ready");
  try {
    const html = renderToStaticMarkup(
      <RecordControls workspaceId="workspace" noteId="note" onStart={() => {}} />,
    );
    expect(html).toContain('data-testid="note-after-recording-toggle"');
    expect(html).toContain("Summary off");
  } finally {
    state.mockRestore();
  }
});

test("an unavailable voice server has no after-recording steps to tell", () => {
  const state = spyOn(availability, "useVoiceAvailability").mockReturnValue("unavailable");
  try {
    const html = renderToStaticMarkup(
      <RecordControls workspaceId="workspace" noteId="note" onStart={() => {}} />,
    );
    expect(html).not.toContain("note-after-recording-toggle");
  } finally {
    state.mockRestore();
  }
});
