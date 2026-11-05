import type * as Monaco from "monaco-editor";
import { useTabsStore } from "@/state/stores/tabs";
import { defaultViewMode } from "../preview/previewable";
import type { MonacoRange } from "../../../../shared/editor/monaco-range";
import type { EditorInput } from "../types";
import { revealRange } from "./reveal";

/**
 * Pending-reveal coordination between callers (search match clicks,
 * workspace-symbol palette, etc.) and live editor instances.
 *
 * Why a registry, not a broadcast bus:
 *   ContentHost keeps every EditorView mounted for the lifetime of its tab —
 *   inactive tabs' DOM is parked off-screen via portal, but the React subtree
 *   is preserved so xterm/Monaco state survives tab moves. With a broadcast
 *   `subscribe / notify` bus, that means every previously-opened file has
 *   a live subscriber. When a new request fires, *any* of those subscribers
 *   can claim the pending entry first — and if the claimer's editor is
 *   parked (visibility:hidden), `editor.focus()` silently no-ops and the
 *   visible editor never sees the reveal. That's exactly the regression
 *   the user reported.
 *
 * Registry semantics:
 *   - Each EditorView mount registers its `IStandaloneCodeEditor` under
 *     `(workspaceId, filePath)` together with its tab id. The same file
 *     open in two splits has one registration per tab.
 *   - `requestEditorReveal` with a tab id (what `revealEditorAt` passes —
 *     the tab it just opened or activated) reveals in that tab's editor.
 *     Without one it uses the most recently mounted editor for the file.
 *     No broadcast, no race.
 *   - When the target editor is not registered yet (the request arrives
 *     before mount), the range is queued under the file's key. The next
 *     mount of that tab (or of any tab, when no tab was named) drains it.
 *   - Unmount removes only its own registration, so closing one split
 *     leaves the other split's editor registered.
 */

export interface PendingEditorReveal extends EditorInput {
  range: MonacoRange;
  /** Tab whose editor should reveal the range; omitted for "any editor of this file". */
  tabId?: string;
}

interface RevealTarget {
  tabId: string | undefined;
  editor: Monaco.editor.IStandaloneCodeEditor;
}

/** Registered editors per file, oldest mount first. */
const targetsByKey = new Map<string, RevealTarget[]>();
const pendingByKey = new Map<string, PendingEditorReveal>();

function keyFor(input: EditorInput): string {
  return `${input.workspaceId}\u0000${input.filePath}`;
}

function findTarget(key: string, tabId: string | undefined): RevealTarget | undefined {
  const targets = targetsByKey.get(key);
  if (!targets) return undefined;
  if (tabId === undefined) return targets.at(-1);
  return targets.find((target) => target.tabId === tabId);
}

/**
 * Register an editor instance as a reveal target for `(workspaceId,
 * filePath)` in tab `tabId`. Returns an unregister function the caller must
 * invoke on unmount.
 *
 * If a pending range is queued for this file and this tab (e.g. the click
 * happened before Monaco finished mounting), it is flushed immediately.
 * Callers do not need a separate "apply pending on mount" call.
 */
export function registerRevealTarget(
  input: EditorInput,
  editor: Monaco.editor.IStandaloneCodeEditor,
  tabId?: string,
): () => void {
  const key = keyFor(input);
  const target: RevealTarget = { tabId, editor };
  const targets = targetsByKey.get(key) ?? [];
  targets.push(target);
  targetsByKey.set(key, targets);

  const pending = pendingByKey.get(key);
  if (pending && (pending.tabId === undefined || pending.tabId === tabId)) {
    pendingByKey.delete(key);
    revealInSource(input.workspaceId, tabId, editor, pending.range);
  }

  return () => {
    const current = targetsByKey.get(key);
    if (!current) return;
    const remaining = current.filter((t) => t !== target);
    if (remaining.length > 0) targetsByKey.set(key, remaining);
    else targetsByKey.delete(key);
  };
}

export function requestEditorReveal(input: PendingEditorReveal): void {
  const key = keyFor(input);
  const target = findTarget(key, input.tabId);
  if (target) {
    revealInSource(input.workspaceId, target.tabId, target.editor, input.range);
    return;
  }
  // Target editor not live yet — queue the range. The next matching
  // `registerRevealTarget` for this key flushes it. We intentionally
  // overwrite any previous queued entry: only the latest user click matters.
  pendingByKey.set(key, input);
}

/**
 * A place in a file is a place in its source: a tab showing the file's
 * preview switches to its source first. Its editor was hidden behind the
 * preview, where it takes no focus and has no size to scroll by, so the
 * reveal waits for it to be shown and laid out.
 */
function revealInSource(
  workspaceId: string,
  tabId: string | undefined,
  editor: Monaco.editor.IStandaloneCodeEditor,
  range: MonacoRange,
): void {
  const tab =
    tabId === undefined ? undefined : useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
  if (tab?.type !== "editor" || (tab.viewMode ?? defaultViewMode(tab.props.filePath)) === "raw") {
    revealRange(editor, range);
    return;
  }
  useTabsStore.getState().setViewMode(workspaceId, tab.id, "raw");
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      editor.layout();
      revealRange(editor, range);
    }),
  );
}

export function __resetPendingEditorRevealsForTests(): void {
  targetsByKey.clear();
  pendingByKey.clear();
}
