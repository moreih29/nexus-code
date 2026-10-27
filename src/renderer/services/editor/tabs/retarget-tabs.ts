import { useTabsStore } from "../../../state/stores/tabs";
import { acquireModel, cacheUriFor, getResolvedModel, releaseModel } from "../model/cache";
import { isDirty } from "../model/dirty-tracker";
import type { EditorInput } from "../types";

/** Whether `filePath` is `path` itself or lies in the folder at `path`. */
export function isPathOrUnder(filePath: string, path: string): boolean {
  return filePath === path || filePath.startsWith(`${path}/`);
}

/**
 * Where `filePath` ends up when `fromPath` (the file itself or a folder above
 * it) moves to `toPath`, or null when the move does not touch it.
 */
export function movedFilePath(filePath: string, fromPath: string, toPath: string): string | null {
  if (!isPathOrUnder(filePath, fromPath)) return null;
  return `${toPath}${filePath.slice(fromPath.length)}`;
}

export interface RetargetEditorTabsDeps {
  /** The text of `input`'s model when it has unsaved changes, else null. */
  readUnsavedText: (input: EditorInput) => string | null;
  acquireModel: typeof acquireModel;
  releaseModel: typeof releaseModel;
}

const defaultDeps: RetargetEditorTabsDeps = {
  readUnsavedText: (input) =>
    isDirty(cacheUriFor(input.workspaceId, input.filePath))
      ? (getResolvedModel(input)?.model.getValue() ?? null)
      : null,
  acquireModel,
  releaseModel,
};

/**
 * Points the workspace's editor tabs at their files' new paths after
 * `fromPath` was renamed or moved to `toPath`. Without this a clean tab
 * shows "not found" and a dirty one saves back to the old path, recreating
 * the file there.
 *
 * A retargeted tab loads its file from the new path. Unsaved text is carried
 * over onto that model as one undoable edit, so undo returns to the content
 * on disk and the tab stays dirty until saved.
 */
export function retargetEditorTabs(
  workspaceId: string,
  fromPath: string,
  toPath: string,
  deps: RetargetEditorTabsDeps = defaultDeps,
): Promise<void> {
  const tabs = Object.values(useTabsStore.getState().byWorkspace[workspaceId] ?? {});
  const moves: Array<{ tabId: string; filePath: string }> = [];
  const unsavedByPath = new Map<string, { input: EditorInput; text: string }>();

  for (const tab of tabs) {
    if (tab.type !== "editor" || tab.props.origin === "external") continue;
    const filePath = movedFilePath(tab.props.filePath, fromPath, toPath);
    if (filePath === null) continue;
    moves.push({ tabId: tab.id, filePath });

    // Read the unsaved text now: a retargeted tab's view releases the old
    // model, which disposes it once no other tab holds it.
    if (unsavedByPath.has(filePath)) continue;
    const text = deps.readUnsavedText({ workspaceId, filePath: tab.props.filePath });
    if (text === null) continue;
    unsavedByPath.set(filePath, { input: { workspaceId, filePath }, text });
  }

  // Acquire the new models before the tabs move, so the views that load them
  // share these entries rather than one that has already dropped the edit.
  const carries = [...unsavedByPath.values()].map(({ input, text }) =>
    carryUnsavedText(input, text, deps.acquireModel(input), deps),
  );
  for (const { tabId, filePath } of moves) {
    useTabsStore.getState().retargetEditorTab(workspaceId, tabId, filePath);
  }
  return Promise.all(carries).then(() => undefined);
}

async function carryUnsavedText(
  input: EditorInput,
  text: string,
  loaded: ReturnType<typeof acquireModel>,
  deps: RetargetEditorTabsDeps,
): Promise<void> {
  try {
    const { model } = await loaded;
    if (model && model.getValue() !== text) {
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
    }
  } catch {
    // The tab's own load reports the failure.
    return;
  }
  deps.releaseModel(input);
}
