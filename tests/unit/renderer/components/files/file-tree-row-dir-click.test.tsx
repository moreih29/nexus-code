/**
 * Regression guard — FileTreeRow forwards the click event for FOLDERS too.
 *
 * The bug: row.tsx bound `onClick={isDir ? onToggle : (e) => onClick(e)}`.
 * Folders got `onToggle` (called with NO event), so the parent's
 * handleRowClick never saw shift/cmd modifiers and folder multi-selection
 * (range / toggle) silently no-op'd. Files worked because they forwarded `e`.
 *
 * The fix makes the binding type-agnostic: `onClick={(e) => onClick(e)}`.
 * Both files AND folders forward the event; the parent decides the primary
 * action (plain folder click → expand, modified click → extend/toggle).
 *
 * HOW THIS TEST RENDERS WITHOUT A DOM
 * -----------------------------------
 * DOM mounting is intentionally avoided in this project (happy-dom caused
 * hangs — see portal-fiber-identity.test.ts). Mirroring browser-view.test.tsx,
 * we mock `react` so its hooks forward to React's live dispatcher slot
 * (`__CLIENT_INTERNALS…H`). Outside our render that slot is React's real
 * dispatcher, so the mock is transparent and never leaks into other test
 * files. During our render we point the slot at a minimal slot-indexed
 * dispatcher, invoke the FileTreeRow function directly, and inspect the
 * returned <button> element's props. No react-i18next mock is needed — the
 * only useTranslation() in row.tsx belongs to a sibling component, not
 * FileTreeRow.
 */

import { describe, expect, it, mock } from "bun:test";

const currentReact = await import("react");
const reactInternals = (
  currentReact as unknown as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
      H: Record<string, (...a: unknown[]) => unknown> | null;
    };
  }
).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

// Transparent delegating mock — forwards every hook to React's live dispatcher.
// Outside our render() the slot holds React's real dispatcher, so this mock is
// inert for all other tests.
mock.module("react", () => ({
  ...currentReact,
  useRef: (init: unknown) => reactInternals.H?.useRef(init),
  useState: (init: unknown) => reactInternals.H?.useState(init),
  useCallback: (cb: unknown, deps?: readonly unknown[]) => reactInternals.H?.useCallback(cb, deps),
  useMemo: (f: () => unknown, deps?: readonly unknown[]) => reactInternals.H?.useMemo(f, deps),
  useEffect: (fn: () => void, deps?: readonly unknown[]) => reactInternals.H?.useEffect(fn, deps),
  useContext: (ctx: unknown) => reactInternals.H?.useContext(ctx),
}));

const { FileTreeRow } = await import(
  "../../../../../src/renderer/components/files/file-tree/row"
);
import type { TreeNode } from "../../../../../src/renderer/state/stores/files";

// Minimal slot-indexed dispatcher: enough for FileTreeRow's useMemo/useState +
// useDragSource's useRef/useCallback/useEffect. Effects are captured, never run.
function withDispatcher<T>(run: () => T): T {
  const refs: Array<{ current: unknown }> = [];
  const states: unknown[] = [];
  let refCursor = 0;
  let stateCursor = 0;
  const dispatcher = {
    useRef(initial: unknown) {
      const i = refCursor++;
      if (!(i in refs)) refs[i] = { current: initial };
      return refs[i];
    },
    useState(initial: unknown) {
      const i = stateCursor++;
      if (!(i in states)) states[i] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [states[i], () => {}];
    },
    useCallback: (cb: unknown) => cb,
    useMemo: (factory: () => unknown) => factory(),
    useEffect: () => {},
    useContext: () => undefined,
  };
  const previous = reactInternals.H;
  reactInternals.H = dispatcher as unknown as typeof reactInternals.H;
  try {
    return run();
  } finally {
    reactInternals.H = previous;
  }
}

const DIR_NODE: TreeNode = {
  absPath: "/repo/src",
  name: "src",
  type: "dir",
  childrenLoaded: true,
  children: [],
};

const FILE_NODE: TreeNode = {
  absPath: "/repo/a.ts",
  name: "a.ts",
  type: "file",
  childrenLoaded: false,
  children: [],
};

interface RenderedButton {
  props: {
    onClick: (e: unknown) => void;
    onDoubleClick?: (e: unknown) => void;
  };
}

function renderButton(node: TreeNode, onClick: (e: unknown) => void): RenderedButton {
  return withDispatcher(() =>
    (FileTreeRow as unknown as (p: Record<string, unknown>) => RenderedButton)({
      id: "row-0",
      workspaceId: "ws",
      absPath: node.absPath,
      node,
      depth: 1,
      isExpanded: false,
      isSelected: false,
      isFocused: false,
      onClick,
      onDoubleClick: () => {},
    }),
  );
}

describe("FileTreeRow — click event forwarding (folder multi-select regression)", () => {
  it("DIR row forwards cmd-click event with metaKey intact", () => {
    const calls: Array<{ metaKey?: boolean }> = [];
    const el = renderButton(DIR_NODE, (e) => calls.push(e as { metaKey?: boolean }));

    el.props.onClick({ metaKey: true, shiftKey: false });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.metaKey).toBe(true);
  });

  it("DIR row forwards shift-click event with shiftKey intact", () => {
    const calls: Array<{ shiftKey?: boolean }> = [];
    const el = renderButton(DIR_NODE, (e) => calls.push(e as { shiftKey?: boolean }));

    el.props.onClick({ metaKey: false, shiftKey: true });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.shiftKey).toBe(true);
  });

  it("FILE row forwards the click event (unchanged behavior)", () => {
    const calls: Array<{ metaKey?: boolean }> = [];
    const el = renderButton(FILE_NODE, (e) => calls.push(e as { metaKey?: boolean }));

    el.props.onClick({ metaKey: true, shiftKey: false });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.metaKey).toBe(true);
  });

  it("double-click stays file-only (dir row has no onDoubleClick)", () => {
    const dir = renderButton(DIR_NODE, () => {});
    const file = renderButton(FILE_NODE, () => {});

    expect(dir.props.onDoubleClick).toBeUndefined();
    expect(file.props.onDoubleClick).toBeDefined();
  });
});
