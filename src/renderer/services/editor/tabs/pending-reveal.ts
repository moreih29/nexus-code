import type * as Monaco from "monaco-editor";
import { usePreviewDefaultsStore } from "@/state/stores/preview-defaults";
import { useTabsStore } from "@/state/stores/tabs";
import type { MonacoRange } from "../../../../shared/editor/monaco-range";
import { defaultViewMode } from "../preview/previewable";
import type { EditorInput } from "../types";
import { revealRange } from "./reveal";

export interface PendingEditorReveal extends EditorInput {
  range: MonacoRange;
  tabId?: string;
  preserveFocus?: boolean;
}

interface RevealTarget {
  tabId: string | undefined;
  editor: Monaco.editor.IStandaloneCodeEditor;
}

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
    revealInSource(input.workspaceId, tabId, editor, pending.range, pending.preserveFocus);
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
    revealInSource(
      input.workspaceId,
      target.tabId,
      target.editor,
      input.range,
      input.preserveFocus,
    );
    return;
  }
  pendingByKey.set(key, input);
}

function revealInSource(
  workspaceId: string,
  tabId: string | undefined,
  editor: Monaco.editor.IStandaloneCodeEditor,
  range: MonacoRange,
  preserveFocus = false,
): void {
  const tab =
    tabId === undefined ? undefined : useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
  const defaults = usePreviewDefaultsStore.getState().byFormat;
  if (
    tab?.type !== "editor" ||
    (tab.viewMode ?? defaultViewMode(tab.props.filePath, defaults)) === "raw"
  ) {
    revealRange(editor, range, preserveFocus);
    return;
  }
  useTabsStore.getState().setViewMode(workspaceId, tab.id, "raw");
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      editor.layout();
      revealRange(editor, range, preserveFocus);
    }),
  );
}

export function __resetPendingEditorRevealsForTests(): void {
  targetsByKey.clear();
  pendingByKey.clear();
}
