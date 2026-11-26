import { expect, test } from "bun:test";
import { surfaceChatSendError } from "../../../../../src/renderer/components/chat/send-error";
import { type ToastInput, watchToasts } from "../../../../../src/renderer/components/ui/toast";
import { ATTACH_FOLDER_LINK } from "../../../../../src/shared/chat/attach-errors";

const attachmentMessage = "Can't attach files because the attachment folder is a link.";

test.each([
  ["chat.stdin-write-failed", "restored", []],
  ["chat.stdin-write-failed", "retained", []],
  ["chat.send-failed", "retained", []],
  ["agent.reconnect-unavailable", "unconfirmed", []],
  [ATTACH_FOLDER_LINK, "restored", [attachmentMessage]],
  [ATTACH_FOLDER_LINK, "retained", [attachmentMessage]],
  ["cancelled", "retained", []],
  ["chat.stdin-write-failed", undefined, ["The operation failed."]],
  ["chat.send-failed", undefined, ["Something went wrong. Check the log for details."]],
] as const)("surfaces %s with draft outcome %s", (kind, outcome, messages) => {
  const toasts: ToastInput[] = [];
  const stop = watchToasts((toast) => toasts.push(toast));
  try {
    surfaceChatSendError(Object.assign(new Error("Send failed"), { kind }), outcome);
  } finally {
    stop();
  }
  expect(toasts.map(({ kind, message }) => [kind, message])).toEqual(
    messages.map((message) => ["error", message]),
  );
});

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
