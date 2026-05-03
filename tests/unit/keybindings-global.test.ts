/**
 * Unit tests for src/renderer/keybindings/global.ts
 *
 * Tests use plain objects that satisfy the minimal shape required by the
 * handler — no DOM, jsdom, or React environment needed. This matches the
 * project's established pattern (see workspace-panel-mount.test.ts).
 *
 * isInEditable() is tested separately with plain HTMLElement-shaped objects
 * so the tagName/isContentEditable/closest logic can be verified without
 * constructing real DOM nodes.
 *
 * handleGlobalKeyDown() receives a minimal KeyboardEvent-shaped mock that
 * exposes: metaKey, shiftKey, key, target, preventDefault(), defaultPrevented.
 */

import { describe, expect, it, mock } from "bun:test";
import {
  type GlobalKeyDeps,
  handleGlobalKeyDown,
  isInEditable,
} from "../../src/renderer/keybindings/global";

// ---------------------------------------------------------------------------
// Minimal event mock — no DOM/browser API required
// ---------------------------------------------------------------------------

interface MockEvent {
  metaKey: boolean;
  shiftKey: boolean;
  key: string;
  target: unknown;
  defaultPrevented: boolean;
  preventDefault: () => void;
}

function makeEvent(
  key: string,
  opts: { metaKey?: boolean; shiftKey?: boolean; target?: unknown } = {},
): MockEvent {
  let prevented = false;
  return {
    key,
    metaKey: opts.metaKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    target: opts.target ?? null,
    get defaultPrevented() {
      return prevented;
    },
    preventDefault() {
      prevented = true;
    },
  };
}

function makeDeps(wsId: string | null = "ws-1"): GlobalKeyDeps & {
  refreshMock: ReturnType<typeof mock>;
  openFileDialogMock: ReturnType<typeof mock>;
} {
  const refreshMock = mock(() => Promise.resolve());
  const openFileDialogMock = mock(() => Promise.resolve());
  return {
    getActiveWorkspaceId: () => wsId,
    refresh: refreshMock as unknown as (wsId: string) => Promise<void>,
    openFileDialog: openFileDialogMock as unknown as (wsId: string) => Promise<void>,
    refreshMock,
    openFileDialogMock,
  };
}

// ---------------------------------------------------------------------------
// isInEditable — tested with plain objects that mimic HTMLElement shape
// ---------------------------------------------------------------------------

describe("isInEditable", () => {
  it("returns true for INPUT element", () => {
    expect(isInEditable({ tagName: "INPUT" } as HTMLElement)).toBe(true);
  });

  it("returns true for TEXTAREA element", () => {
    expect(isInEditable({ tagName: "TEXTAREA" } as HTMLElement)).toBe(true);
  });

  it("returns true for contentEditable element", () => {
    const el = { tagName: "DIV", isContentEditable: true, closest: () => null } as unknown as HTMLElement;
    expect(isInEditable(el)).toBe(true);
  });

  it("returns true when element is inside .cm-editor (closest returns truthy)", () => {
    const el = {
      tagName: "SPAN",
      isContentEditable: false,
      closest: (sel: string) => (sel === ".cm-editor" ? {} : null),
    } as unknown as HTMLElement;
    expect(isInEditable(el)).toBe(true);
  });

  it("returns false for a plain non-editable DIV", () => {
    const el = {
      tagName: "DIV",
      isContentEditable: false,
      closest: () => null,
    } as unknown as HTMLElement;
    expect(isInEditable(el)).toBe(false);
  });

  it("returns false for null target", () => {
    expect(isInEditable(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleGlobalKeyDown — Cmd+R
// ---------------------------------------------------------------------------

describe("handleGlobalKeyDown — Cmd+R", () => {
  it("calls deps.refresh and preventDefault on Cmd+R (lowercase r)", () => {
    const deps = makeDeps("ws-1");
    const e = makeEvent("r", { metaKey: true });

    handleGlobalKeyDown(e as unknown as KeyboardEvent, deps);

    expect(deps.refreshMock).toHaveBeenCalledTimes(1);
    expect(deps.refreshMock).toHaveBeenCalledWith("ws-1");
    expect(e.defaultPrevented).toBe(true);
  });

  it("calls deps.refresh and preventDefault on Cmd+Shift+R (uppercase R)", () => {
    const deps = makeDeps("ws-1");
    const e = makeEvent("R", { metaKey: true, shiftKey: true });

    handleGlobalKeyDown(e as unknown as KeyboardEvent, deps);

    expect(deps.refreshMock).toHaveBeenCalledTimes(1);
    expect(deps.refreshMock).toHaveBeenCalledWith("ws-1");
    expect(e.defaultPrevented).toBe(true);
  });

  it("still calls preventDefault even when no active workspace", () => {
    const deps = makeDeps(null);
    const e = makeEvent("r", { metaKey: true });

    handleGlobalKeyDown(e as unknown as KeyboardEvent, deps);

    expect(deps.refreshMock).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it("does not intercept Cmd+R when metaKey is false", () => {
    const deps = makeDeps("ws-1");
    const e = makeEvent("r", { metaKey: false });

    handleGlobalKeyDown(e as unknown as KeyboardEvent, deps);

    expect(deps.refreshMock).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleGlobalKeyDown — Cmd+E editable guard
// ---------------------------------------------------------------------------

describe("handleGlobalKeyDown — Cmd+E editable guard", () => {
  it("does not call openFileDialog or preventDefault when target is INPUT", () => {
    const deps = makeDeps("ws-1");
    const target = { tagName: "INPUT" } as HTMLElement;
    const e = makeEvent("e", { metaKey: true, target });

    handleGlobalKeyDown(e as unknown as KeyboardEvent, deps);

    expect(deps.openFileDialogMock).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("does not call openFileDialog when target is TEXTAREA", () => {
    const deps = makeDeps("ws-1");
    const target = { tagName: "TEXTAREA" } as HTMLElement;
    const e = makeEvent("e", { metaKey: true, target });

    handleGlobalKeyDown(e as unknown as KeyboardEvent, deps);

    expect(deps.openFileDialogMock).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("does not call openFileDialog when target is contentEditable", () => {
    const deps = makeDeps("ws-1");
    const target = {
      tagName: "DIV",
      isContentEditable: true,
      closest: () => null,
    } as unknown as HTMLElement;
    const e = makeEvent("e", { metaKey: true, target });

    handleGlobalKeyDown(e as unknown as KeyboardEvent, deps);

    expect(deps.openFileDialogMock).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("does not call openFileDialog when target is nested inside .cm-editor", () => {
    const deps = makeDeps("ws-1");
    const target = {
      tagName: "SPAN",
      isContentEditable: false,
      closest: (sel: string) => (sel === ".cm-editor" ? {} : null),
    } as unknown as HTMLElement;
    const e = makeEvent("e", { metaKey: true, target });

    handleGlobalKeyDown(e as unknown as KeyboardEvent, deps);

    expect(deps.openFileDialogMock).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("calls openFileDialog and preventDefault when target is a plain non-editable element", () => {
    const deps = makeDeps("ws-1");
    const target = {
      tagName: "DIV",
      isContentEditable: false,
      closest: () => null,
    } as unknown as HTMLElement;
    const e = makeEvent("e", { metaKey: true, target });

    handleGlobalKeyDown(e as unknown as KeyboardEvent, deps);

    expect(deps.openFileDialogMock).toHaveBeenCalledTimes(1);
    expect(deps.openFileDialogMock).toHaveBeenCalledWith("ws-1");
    expect(e.defaultPrevented).toBe(true);
  });

  it("does not call openFileDialog when no active workspace", () => {
    const deps = makeDeps(null);
    const target = {
      tagName: "DIV",
      isContentEditable: false,
      closest: () => null,
    } as unknown as HTMLElement;
    const e = makeEvent("e", { metaKey: true, target });

    handleGlobalKeyDown(e as unknown as KeyboardEvent, deps);

    expect(deps.openFileDialogMock).not.toHaveBeenCalled();
    // preventDefault is still called before the wsId guard
    expect(e.defaultPrevented).toBe(true);
  });
});
