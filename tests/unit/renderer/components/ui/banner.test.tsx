/**
 * Banner — inline display keeps details collapsed under its message.
 */
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Banner } from "../../../../../src/renderer/components/ui/banner";

describe("inline Banner details", () => {
  it("shows the message and collapses details behind a Details toggle", () => {
    const html = renderToStaticMarkup(
      <Banner message="Remote has commits you don't have." details="! [rejected] main -> main" />,
    );
    expect(html).toContain("Remote has commits you don&#x27;t have.");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("[rejected]");
  });

  it("renders no toggle without details", () => {
    const html = renderToStaticMarkup(<Banner message="Up to date." />);
    expect(html).not.toContain("aria-expanded");
  });
});
