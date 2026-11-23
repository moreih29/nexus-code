import { expect, test } from "bun:test";
import { surfaceChatSendError } from "../../../../../src/renderer/components/chat/send-error";
import { type ToastInput, watchToasts } from "../../../../../src/renderer/components/ui/toast";

test("an attach refused for a linked attach folder says so, not that the app failed", () => {
  const toasts: ToastInput[] = [];
  const stop = watchToasts((toast) => toasts.push(toast));
  try {
    surfaceChatSendError(
      Object.assign(new Error("The tab's attach folder is a link"), {
        kind: "chat.attach-folder-link",
      }),
    );
  } finally {
    stop();
  }
  expect(toasts.map((toast) => [toast.kind, toast.message])).toEqual([
    ["error", "Can't attach files because the attachment folder is a link."],
  ]);
});
