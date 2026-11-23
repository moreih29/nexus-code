/** The confirmation's text keeps Korean words whole through the header's class merge. */
import { expect, test } from "bun:test";
import { Dialog } from "radix-ui";
import { renderToStaticMarkup } from "react-dom/server";
import { CONFIRM_TEXT_CLASS } from "../../../../src/renderer/components/ui/confirm-dialog";
import { DialogHeader } from "../../../../src/renderer/components/ui/dialog-header";

test("the description keeps break-keep and wrap-break-word after cn() merges them", () => {
  const html = renderToStaticMarkup(
    <Dialog.Root open>
      <DialogHeader title="t" description="지웁니다." descriptionClassName={CONFIRM_TEXT_CLASS} />
    </Dialog.Root>,
  );
  const cls = /<p[^>]*class="([^"]*)"[^>]*>지웁니다\./.exec(html)?.[1] ?? "";
  expect(cls.split(" ")).toContain("break-keep");
  expect(cls.split(" ")).toContain("wrap-break-word");
});
