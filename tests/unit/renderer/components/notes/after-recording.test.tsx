import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AfterRecordingSteps } from "../../../../../src/renderer/components/notes/after-recording";

function steps(html: string): (string | undefined)[] {
  return Array.from(html.matchAll(/data-step="([^"]+)"/g), (match) => match[1]);
}

test("lists what runs after a recording, in order, with the summary's result place", () => {
  const html = renderToStaticMarkup(
    <AfterRecordingSteps summary voicePrint onSettings={() => {}} />,
  );
  expect(html).toContain("When the recording ends");
  expect(steps(html)).toEqual(["refine", "speakers", "summary"]);
  expect(html).toContain("Summary and to-dos added at the end of the note");
  expect(html).toContain("Open note settings");
});

test("says the summary is off and where to turn it on", () => {
  const html = renderToStaticMarkup(
    <AfterRecordingSteps summary={false} voicePrint={false} onSettings={() => {}} />,
  );
  expect(steps(html)).toEqual(["refine", "summary"]);
  expect(html).toContain("Off · Turn on in note settings");
});
