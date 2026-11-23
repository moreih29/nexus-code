import type * as Monaco from "monaco-editor";
import { isWithinWorkspace } from "../../../utils/path";
import type { EditorInput } from "../types";

export const PEEK_PREACQUIRE_HOLD_MS = 30_000;

export const PEEK_PREACQUIRE_MAX_FILES = 20;

export interface PreAcquireCancellation {
  readonly isCancellationRequested: boolean;
}

export interface CacheEntryMeta {
  workspaceId: string;
}

export interface PreAcquireDeps {
  acquireModel: (input: EditorInput) => Promise<unknown>;
  releaseModel: (input: EditorInput) => void;
  getEntryMetadata: (cacheUri: string) => CacheEntryMeta | null;
  workspaceRootForId: (workspaceId: string) => string | null;
  cacheUriToFilePath: (cacheUri: string) => string | null;
}

function inputForLocation(
  filePath: string,
  workspaceId: string,
  workspaceRoot: string | null,
): EditorInput {
  if (workspaceRoot !== null && isWithinWorkspace(filePath, workspaceRoot)) {
    return { workspaceId, filePath };
  }
  return { workspaceId, filePath, origin: "external", readOnly: true };
}

export async function preAcquireLocationModels(
  locations: readonly Monaco.languages.Location[],
  sourceCacheUri: string,
  deps: PreAcquireDeps,
  token?: PreAcquireCancellation,
): Promise<void> {
  if (locations.length === 0 || token?.isCancellationRequested) return;

  const sourceMeta = deps.getEntryMetadata(sourceCacheUri);
  if (!sourceMeta) return;

  const { workspaceId } = sourceMeta;
  const workspaceRoot = deps.workspaceRootForId(workspaceId);

  const seenPaths = new Set<string>();
  const inputs: EditorInput[] = [];

  for (const location of locations) {
    const targetUri = location.uri.toString();
    if (targetUri === sourceCacheUri) continue;

    const filePath = deps.cacheUriToFilePath(targetUri);
    if (filePath === null) continue;
    if (seenPaths.has(filePath)) continue;
    seenPaths.add(filePath);

    inputs.push(inputForLocation(filePath, workspaceId, workspaceRoot));
    if (inputs.length >= PEEK_PREACQUIRE_MAX_FILES) break;
  }

  await Promise.all(
    inputs.map(async (input) => {
      try {
        await deps.acquireModel(input);
        scheduleRelease(input, deps.releaseModel);
      } catch {}
    }),
  );
}

function scheduleRelease(input: EditorInput, release: PreAcquireDeps["releaseModel"]): void {
  setTimeout(() => {
    try {
      release(input);
    } catch {}
  }, PEEK_PREACQUIRE_HOLD_MS);
}
