/**
 * Unit tests for toast component warning-severity semantics.
 *
 * Strategy: render the real ToastRoot with renderToStaticMarkup after queuing
 * a toast through the real showToast.
 *
 * Module isolation: several service tests (e.g. fs-toast-errors.test.ts)
 * replace toast.tsx process-wide via mock.module(), and the toast stack is
 * module state with no reset hook. Importing the file with a unique query
 * string loads a fresh, unmocked module instance per render, so these tests
 * see neither the mocks nor each other's toasts.
 *
 * The assertions validate:
 *   1. role="status" + aria-live="polite" for warning/info/error plain toasts.
 *   2. role="alert" + aria-live="assertive" for action toasts (regression check).
 *   3. Warning icon (TriangleAlert) rendered only for kind="warning".
 *   4. Severity token classes on the toast container.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ToastInput } from "../../../../../src/renderer/components/ui/toast";

type ToastModule = typeof import("../../../../../src/renderer/components/ui/toast");

const TOAST_MODULE_PATH = "../../../../../src/renderer/components/ui/toast.tsx";
let instance = 0;

/** Shows `input` on a fresh toast module instance and renders its ToastRoot. */
async function renderToast(input: ToastInput): Promise<string> {
  const toast: ToastModule = await import(`${TOAST_MODULE_PATH}?instance=${instance++}`);
  toast.showToast(input);
  return renderToStaticMarkup(<toast.ToastRoot />);
}

const retryAction = { label: "Retry", onAction: () => {} };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("toast role / aria-live — plain toasts (no actions)", () => {
  it("warning kind renders role=status + aria-live=polite", async () => {
    const html = await renderToast({ kind: "warning", message: "Folder is not empty." });
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("assertive");
  });

  it("error kind renders role=status + aria-live=polite (plain, no actions)", async () => {
    const html = await renderToast({ kind: "error", message: "Something failed." });
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain('role="alert"');
  });

  it("info kind renders role=status + aria-live=polite", async () => {
    const html = await renderToast({ kind: "info", message: "Saved." });
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });
});

describe("toast role / aria-live — action toasts (regression)", () => {
  it("action toast renders role=alert + aria-live=assertive and its action button", async () => {
    const html = await renderToast({
      kind: "error",
      message: "Save failed.",
      actions: [retryAction],
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="assertive"');
    expect(html).not.toContain('role="status"');
    expect(html).toContain(">Retry</button>");
  });
});

describe("toast warning icon — WCAG 1.4.1 second encoding channel", () => {
  it("warning kind renders the TriangleAlert icon with aria-hidden=true", async () => {
    const html = await renderToast({ kind: "warning", message: "Folder is not empty." });
    expect(html).toContain("lucide-triangle-alert");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("size-4");
  });

  it("error kind does NOT render the warning icon", async () => {
    const html = await renderToast({ kind: "error", message: "Something failed." });
    expect(html).not.toContain("lucide-triangle-alert");
  });

  it("info kind does NOT render the warning icon", async () => {
    const html = await renderToast({ kind: "info", message: "Done." });
    expect(html).not.toContain("lucide-triangle-alert");
  });
});

describe("toast severity token classes", () => {
  it("warning kind carries the state-warning-* token classes", async () => {
    const html = await renderToast({ kind: "warning", message: "Folder is not empty." });
    expect(html).toContain("bg-[var(--state-warning-bg)]");
    expect(html).toContain("text-[var(--state-warning-fg)]");
    expect(html).toContain("border-[var(--state-warning-border)]");
  });

  it("error kind carries the destructive token classes, not warning", async () => {
    const html = await renderToast({ kind: "error", message: "Error." });
    expect(html).toContain("bg-destructive text-destructive-foreground border-destructive");
    expect(html).not.toContain("state-warning");
  });

  it("info kind carries the popover token classes, not warning or destructive", async () => {
    const html = await renderToast({ kind: "info", message: "Info." });
    expect(html).toContain("bg-popover text-popover-foreground border-border");
    expect(html).not.toContain("state-warning");
    expect(html).not.toContain("bg-destructive");
  });
});

describe("toast details", () => {
  it("collapses details behind a Details toggle", async () => {
    const html = await renderToast({
      kind: "error",
      message: "Pull failed.",
      details: "fatal: raw git output",
    });
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Details");
    expect(html).not.toContain("fatal: raw git output");
  });
});
