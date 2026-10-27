import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ErrorBoundary } from "../../../../../src/renderer/components/ui/error-boundary";

describe("ErrorBoundary default fallback", () => {
  it("shows a localized notice without the log source or raw message", () => {
    const boundary = new ErrorBoundary({ logSource: "workspace-panel:ws-1", children: null });
    boundary.state = { caught: true, error: new Error("Cannot read properties of undefined") };
    const html = renderToStaticMarkup(boundary.render());
    expect(html).toContain("Something went wrong. Check the log for details.");
    expect(html).not.toContain("workspace-panel");
    expect(html).not.toContain("Cannot read properties");
  });
});
