import { expect, test } from "bun:test";
import { act } from "react";
import { PreviewPane } from "../../../../../../src/renderer/components/workspace/content/editor-view";
import { withTestDom } from "../../../../../helpers/test-dom";

test("the first Markdown preview renders allowed raw HTML and code highlighting", async () => {
  await withTestDom(async (host, root) => {
    await act(async () => {
      root.render(
        <PreviewPane
          filePath="/workspace/README.md"
          workspaceId="ws"
          workspaceRootAbsPath="/workspace"
          source={"<details><summary>Details</summary></details>\n\n```js\nconst n = 1;\n```"}
        />,
      );
    });
    await act(async () => {
      await import("../../../../../../src/renderer/components/editor/preview/markdown-preview");
    });
    expect(host.querySelector("details > summary")?.textContent).toBe("Details");
    expect(host.querySelector("code .hljs-keyword")?.textContent).toBe("const");
  });
});
