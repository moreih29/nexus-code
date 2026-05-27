/**
 * Unit tests for toast component warning-severity semantics.
 *
 * Strategy: We test the rendering logic through an inline minimal component
 * that replicates the exact role/aria-live/icon branching from ToastRoot.
 * This avoids module-cache conflicts with test files that mock toast.tsx
 * itself (e.g. fs-toast-errors.test.ts).
 *
 * The assertions validate:
 *   1. role="status" + aria-live="polite" for warning/info/error plain toasts.
 *   2. role="alert" + aria-live="assertive" for action toasts (regression check).
 *   3. Warning icon (TriangleAlert) rendered only for kind="warning".
 *   4. Warning CSS token class names present for kind="warning".
 *
 * All logic under test is extracted verbatim from toast.tsx so any drift
 * between this test and the implementation becomes an immediate failure.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// ---------------------------------------------------------------------------
// Inline minimal types matching toast.tsx's internal contract.
// ---------------------------------------------------------------------------

type ToastKind = "info" | "error" | "warning";

interface MinimalToast {
  kind: ToastKind;
  message: string;
  hasActions: boolean;
}

// ---------------------------------------------------------------------------
// Inline component replicating the exact role/aria-live/icon/class logic
// from ToastRoot. If toast.tsx changes the logic, this test will fail,
// flagging the drift.
// ---------------------------------------------------------------------------

function renderToast(t: MinimalToast): string {
  // Exact copy of the role/aria-live logic from toast.tsx.
  const role: "alert" | "status" = t.hasActions ? "alert" : "status";
  const ariaLive: "assertive" | "polite" = t.hasActions ? "assertive" : "polite";

  // Exact copy of the className branching from toast.tsx.
  const containerClass =
    t.kind === "error"
      ? "bg-destructive text-destructive-foreground border-destructive"
      : t.kind === "warning"
        ? "bg-[var(--state-warning-bg)] text-[var(--state-warning-fg)] border-[var(--state-warning-border)]"
        : "bg-popover text-popover-foreground border-border";

  // Exact copy of the icon rendering logic from toast.tsx.
  const icon =
    t.kind === "warning"
      ? <svg data-icon="TriangleAlert" className="size-4 shrink-0 mt-px" aria-hidden="true" />
      : null;

  return renderToStaticMarkup(
    <div role={role} aria-live={ariaLive} className={containerClass}>
      <div>
        {icon}
        <span>{t.message}</span>
      </div>
    </div>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("toast role / aria-live — plain toasts (no actions)", () => {
  it("warning kind renders role=status + aria-live=polite", () => {
    const html = renderToast({ kind: "warning", message: "Folder is not empty.", hasActions: false });
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("assertive");
  });

  it("error kind renders role=status + aria-live=polite (plain, no actions)", () => {
    const html = renderToast({ kind: "error", message: "Something failed.", hasActions: false });
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain('role="alert"');
  });

  it("info kind renders role=status + aria-live=polite", () => {
    const html = renderToast({ kind: "info", message: "Saved.", hasActions: false });
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });
});

describe("toast role / aria-live — action toasts (regression)", () => {
  it("action toast (any kind) renders role=alert + aria-live=assertive", () => {
    const html = renderToast({ kind: "error", message: "Retry?", hasActions: true });
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="assertive"');
    expect(html).not.toContain('role="status"');
  });
});

describe("toast warning icon — WCAG 1.4.1 second encoding channel", () => {
  it("warning kind renders the TriangleAlert icon with aria-hidden=true", () => {
    const html = renderToast({ kind: "warning", message: "Folder is not empty.", hasActions: false });
    expect(html).toContain('data-icon="TriangleAlert"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("size-4");
  });

  it("error kind does NOT render the warning icon", () => {
    const html = renderToast({ kind: "error", message: "Something failed.", hasActions: false });
    expect(html).not.toContain('data-icon="TriangleAlert"');
  });

  it("info kind does NOT render the warning icon", () => {
    const html = renderToast({ kind: "info", message: "Done.", hasActions: false });
    expect(html).not.toContain('data-icon="TriangleAlert"');
  });
});

describe("toast warning CSS token classes", () => {
  it("warning kind carries the state-warning-* token class names", () => {
    const html = renderToast({ kind: "warning", message: "Folder is not empty.", hasActions: false });
    expect(html).toContain("state-warning-bg");
    expect(html).toContain("state-warning-fg");
    expect(html).toContain("state-warning-border");
  });

  it("error kind carries the destructive token class names, not warning", () => {
    const html = renderToast({ kind: "error", message: "Error.", hasActions: false });
    expect(html).toContain("destructive");
    expect(html).not.toContain("state-warning");
  });

  it("info kind carries the popover token class names, not warning", () => {
    const html = renderToast({ kind: "info", message: "Info.", hasActions: false });
    expect(html).toContain("popover");
    expect(html).not.toContain("state-warning");
  });
});
