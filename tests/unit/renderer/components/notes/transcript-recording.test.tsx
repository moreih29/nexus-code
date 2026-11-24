import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

const { PickedSpeaker } = await import(
  "../../../../../src/renderer/components/notes/transcript-recording"
);

describe("the picked person above the transcript", () => {
  test("names them, and is the way back to everyone", () => {
    const html = renderToStaticMarkup(
      <PickedSpeaker name="Speaker 3" color="#4f8cff" onClear={() => {}} />,
    );
    expect(html).toContain("Speaker 3");
    expect(html).toContain('title="Everyone again"');
    expect(html).toContain("background:#4f8cff");
  });

  test("without a color once their voices are grouped again", () => {
    const html = renderToStaticMarkup(
      <PickedSpeaker name="Speaker 2" color={null} onClear={() => {}} />,
    );
    expect(html).toContain("Speaker 2");
    expect(html).not.toContain("rounded-full");
  });
});

const { SpeakerCountPrompt } = await import(
  "../../../../../src/renderer/components/notes/transcript-recording"
);

const split = {
  id: "rmhz00cc0abcd",
  startedAt: 0,
  language: "en",
  takes: [{ file: "recordings/rmhz00cc0abcd-1.webm", offsetMs: 0, seconds: 60, pass: "done" }],
  speakers: {},
  lines: ["1", "2", "3", "4", "5"].map((speaker, index) => ({
    speaker,
    startMs: index * 10_000,
    endMs: index * 10_000 + 9_000,
    text: "a",
  })),
} as const;

describe("after a recording, above the transcript", () => {
  test("the speaker count question says the summary waits for it", () => {
    const html = renderToStaticMarkup(
      <SpeakerCountPrompt workspaceId="ws" noteId="note" recording={split} summaryNext />,
    );
    expect(html).toContain("Speech was split into 5 speakers");
    expect(html).toContain("The Claude summary starts once the count is chosen or this is closed");
  });

  test("without a summary to wait, the question stands alone", () => {
    const html = renderToStaticMarkup(
      <SpeakerCountPrompt workspaceId="ws" noteId="note" recording={split} summaryNext={false} />,
    );
    expect(html).not.toContain("The Claude summary starts");
  });
});
