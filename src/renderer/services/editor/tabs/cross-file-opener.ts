import { isWithinWorkspace } from "../../../utils/path";
import { cacheUriToFilePath } from "../model/model-cache";
import { openOrRevealEditor } from "./open-editor";
import { openExternalEditor } from "./open-external-editor";

export interface ResourceUriLike {
  toString(): string;
}

export interface CrossFileOpenCodeEditorOpener {
  openCodeEditor(source: unknown, resource: ResourceUriLike): boolean;
}

export interface CreateCrossFileOpenCodeEditorOpenerInput {
  getWorkspaceId: () => string;
  getWorkspaceRoot: () => string | null;
  sourceEditor: unknown;
  openEditor?: (input: { workspaceId: string; filePath: string }) => unknown;
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

export function createCrossFileOpenCodeEditorOpener({
  getWorkspaceId,
  getWorkspaceRoot,
  sourceEditor,
  openEditor = openOrRevealEditor,
  openExternal = openExternalEditor,
  uriToFilePath = cacheUriToFilePath,
}: CreateCrossFileOpenCodeEditorOpenerInput): CrossFileOpenCodeEditorOpener {
  return {
    openCodeEditor(source, resource) {
      if (source !== sourceEditor) return false;

      const resourceUri = resourceToString(resource);
      if (!resourceUri) return false;

      if (sourceModelUri(source) === resourceUri) return false;

      const filePath = uriToFilePath(resourceUri);
      if (filePath === null) return false;

      const workspaceId = getWorkspaceId();
      const workspaceRoot = getWorkspaceRoot();

      if (workspaceRoot !== null && isWithinWorkspace(filePath, workspaceRoot)) {
        openEditor({ workspaceId, filePath });
      } else {
        // Fire-and-forget: Monaco requires a synchronous boolean return.
        openExternal({ workspaceId, filePath });
      }
      return true;
    },
  };
}
