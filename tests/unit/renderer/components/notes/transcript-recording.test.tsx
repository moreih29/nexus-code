/** The person the transcript shows alone, above its lines. */
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
