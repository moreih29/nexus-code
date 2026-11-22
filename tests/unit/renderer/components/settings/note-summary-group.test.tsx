import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NoteSummaryGroup } from "../../../../../src/renderer/components/settings/panels/note-summary-group";

test("recording summary settings start off and label the Claude-only choices and summary data path", () => {
  const html = renderToStaticMarkup(<NoteSummaryGroup />);
  expect(html).toContain("Summarize recordings automatically");
  expect(html).toContain('aria-checked="false"');
  expect(html).toContain('aria-label="Claude profile"');
  expect(html).toContain("Profile default");
  expect(html).toContain("Transcript sent to Claude for summaries · Not through NexusCode servers");
  expect(html).toContain("Bedrock, Vertex and apiKeyHelper profiles not supported");
});
