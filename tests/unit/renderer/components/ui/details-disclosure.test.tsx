import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DetailsDisclosure } from "../../../../../src/renderer/components/ui/details-disclosure";

test("a notice's details end with a chevron down while folded", () => {
  const html = renderToStaticMarkup(<DetailsDisclosure details="stack" />);
  expect(html).toContain('aria-expanded="false"');
  expect(html.indexOf("lucide-chevron-down")).toBeGreaterThan(html.indexOf(">Details"));
  expect(html).not.toContain("lucide-chevron-right");
});
