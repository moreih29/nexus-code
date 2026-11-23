import { expect, spyOn, test } from "bun:test";
import { act } from "react";
import { CopyButton } from "../../../../../src/renderer/components/ui/copy-button";
import * as clipboard from "../../../../../src/renderer/utils/clipboard";
import { withTestDom } from "../../../../helpers/test-dom";

test.each([
  "text",
  "icon",
] as const)("a %s copy button is named as it reads, before and after copying", async (variant) => {
  const copy = spyOn(clipboard, "copyText").mockImplementation(() => {});
  try {
    await withTestDom(async (host, root) => {
      await act(async () =>
        root.render(
          <CopyButton
            variant={variant}
            text="/logs"
            label="Copy path"
            copiedLabel="Copied"
            data-testid="copy"
          />,
        ),
      );
      const button = host.querySelector<HTMLButtonElement>('[data-testid="copy"]');
      expect(button?.getAttribute("aria-label")).toBe("Copy path");
      await act(async () => button?.click());
      expect(copy).toHaveBeenCalledWith("/logs");
      expect(button?.getAttribute("aria-label")).toBe("Copied");
      if (variant === "text") expect(button?.textContent).toBe("Copied");
    });
  } finally {
    copy.mockRestore();
  }
});
