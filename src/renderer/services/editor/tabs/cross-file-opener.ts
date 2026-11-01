import type { MonacoRange } from "../../../../shared/editor/monaco-range";
import { isWithinWorkspace } from "../../../utils/path";
import { cacheUriToFilePath } from "../model/cache";
import { openExternalEditor } from "./open-external-editor";
import { revealEditorAt } from "./reveal-editor-at";

export interface ResourceUriLike {
  toString(): string;
}

/** Where Monaco wants the opened file's cursor: a range or a position. */
export type SelectionOrPosition = MonacoRange | { lineNumber: number; column: number };

export interface CrossFileOpenCodeEditorOpener {
  openCodeEditor(
    source: unknown,
    resource: ResourceUriLike,
    selectionOrPosition?: SelectionOrPosition,
  ): boolean;
}

export interface CreateCrossFileOpenCodeEditorOpenerInput {
  getWorkspaceId: () => string;
  getWorkspaceRoot: () => string | null;
  sourceEditor: unknown;
  openEditor?: (
    input: { workspaceId: string; filePath: string },
    selection?: MonacoRange,
  ) => unknown;
  openExternal?: (input: { workspaceId: string; filePath: string }) => unknown;
  uriToFilePath?: (cacheUri: string) => string | null;
}

function resourceToString(resource: ResourceUriLike): string | null {
  try {
    return resource.toString();
  } catch {
    return null;
  }
}

function sourceModelUri(source: unknown): string | null {
  if (typeof source !== "object" || source === null || !("getModel" in source)) {
    return null;
  }

  const getModel = source.getModel;
  if (typeof getModel !== "function") return null;

  const model = getModel.call(source) as unknown;
  if (typeof model !== "object" || model === null || !("uri" in model)) {
    return null;
  }

  const uri = (model as { uri?: unknown }).uri;
  if (typeof uri !== "object" || uri === null || !("toString" in uri)) {
    return null;
  }

  const uriToString = uri.toString;
  if (typeof uriToString !== "function") return null;

  try {
    return uriToString.call(uri);
  } catch {
    return null;
  }
}

function toRange(target: SelectionOrPosition | undefined): MonacoRange | undefined {
  if (!target || !("lineNumber" in target)) return target;
  const { lineNumber, column } = target;
  return {
    startLineNumber: lineNumber,
    startColumn: column,
    endLineNumber: lineNumber,
    endColumn: column,
  };
}

export function createCrossFileOpenCodeEditorOpener({
  getWorkspaceId,
  getWorkspaceRoot,
  sourceEditor,
  openEditor = (input, selection) => revealEditorAt(input, { selection }),
  openExternal = openExternalEditor,
  uriToFilePath = cacheUriToFilePath,
}: CreateCrossFileOpenCodeEditorOpenerInput): CrossFileOpenCodeEditorOpener {
  return {
    openCodeEditor(source, resource, selectionOrPosition) {
      if (source !== sourceEditor) return false;

      const resourceUri = resourceToString(resource);
      if (!resourceUri) return false;

      if (sourceModelUri(source) === resourceUri) return false;

      const filePath = uriToFilePath(resourceUri);
      if (filePath === null) return false;

      const workspaceId = getWorkspaceId();
      const workspaceRoot = getWorkspaceRoot();

      if (workspaceRoot !== null && isWithinWorkspace(filePath, workspaceRoot)) {
        // Go to Definition and the like land on the symbol, not line 1.
        openEditor({ workspaceId, filePath }, toRange(selectionOrPosition));
      } else {
        // Fire-and-forget: Monaco requires a synchronous boolean return.
        openExternal({ workspaceId, filePath });
      }
      return true;
    },
  };
}
