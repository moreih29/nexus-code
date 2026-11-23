import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionRowLines } from "../../../../../src/renderer/components/agent-list/session-row";

const chip = <span data-testid="chip">2</span>;

test("a row with nothing under its title keeps its family chip on the title line", () => {
  const html = renderToStaticMarkup(
    <SessionRowLines icon={null} title="Plan" sign={<i />} family={chip} />,
  );
  expect(html).not.toContain("pl-5.5");
  expect(html.indexOf('data-testid="chip"')).toBeLessThan(html.indexOf("<i>"));
});

test("a row with a preview keeps its family chip beside the preview", () => {
  const html = renderToStaticMarkup(
    <SessionRowLines icon={null} title="Plan" preview="Failed" family={chip} />,
  );
  expect(html).toContain("pl-5.5");
  expect(html.indexOf("Failed")).toBeLessThan(html.indexOf('data-testid="chip"'));
});
