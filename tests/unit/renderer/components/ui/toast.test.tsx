import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  dismissToast,
  runToastAction,
  showToast,
  ToastRoot,
} from "../../../../../src/renderer/components/ui/toast";

test("merges duplicate toast content without folding different diagnostics together", () => {
  const message = "diagnostic toast deduplication";
  const first = showToast({ kind: "error", message, details: "diagnostic A" });
  const duplicate = showToast({ kind: "error", message, details: "diagnostic A" });
  const other = showToast({ kind: "error", message, details: "diagnostic B" });
  try {
    expect(renderToStaticMarkup(<ToastRoot />).split(message)).toHaveLength(3);
    expect(duplicate).toBe(first);
  } finally {
    for (const id of [first, duplicate, other]) dismissToast(id);
  }
});

test("keeps only five toasts and evicts the oldest one even if it still has actions", () => {
  const acted: string[] = [];
  const messages = Array.from({ length: 6 }, (_, index) => `toast FIFO ${index}`);
  const ids = messages.map((message) =>
    showToast({
      kind: "error",
      message,
      details: `diagnostic for ${message}`,
      actions: [{ label: `Retry ${message}`, onAction: () => acted.push(message) }],
    }),
  );
  try {
    const html = renderToStaticMarkup(<ToastRoot />);
    expect(html).not.toContain(messages[0]);
    for (const message of messages.slice(1)) expect(html).toContain(`Retry ${message}`);
    expect(html.match(/role="alert"/g)).toHaveLength(5);
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(5);
    runToastAction(ids[0], 0);
    dismissToast(ids[1]);
    runToastAction(ids[1], 0);
    runToastAction(ids[2], 0);
    runToastAction(ids[2], 0);
    expect(acted).toEqual([messages[2]]);
  } finally {
    for (const id of ids) dismissToast(id);
  }
});

test("keeps the original action for a repeat and preserves actions for other targets", () => {
  const acted: string[] = [];
  const add = (dedupeKey: string, value: string) =>
    showToast({
      kind: "error",
      message: "action toast deduplication",
      actions: [{ label: "Retry", dedupeKey, onAction: () => acted.push(value) }],
    });
  const first = add("target A", "original");
  const repeat = add("target A", "repeat");
  const other = add("target B", "other target");
  try {
    expect(repeat).toBe(first);
    expect(other).not.toBe(first);
    runToastAction(first, 0);
    runToastAction(other, 0);
    expect(acted).toEqual(["original", "other target"]);
  } finally {
    for (const id of [first, repeat, other]) dismissToast(id);
  }
});
