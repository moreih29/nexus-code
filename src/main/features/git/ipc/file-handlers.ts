/**
 * File handlers — bounded HEAD reads and large blob streaming for Git context
 * menu actions.
 */
import {
  type InferArgs,
  type InferComplete,
  type InferProgress,
  ipcContract,
} from "../../../../shared/ipc/contract";
import type { StreamContext } from "../../../infra/ipc-router";
import { GitError } from "../domain/error";
import type { GitRegistry } from "../domain/registry";
import { withRepo } from "./git-result";

const c = ipcContract.git.call;

type BlobStreamProcedure = (typeof ipcContract)["git"]["stream"]["getFileBlob"];
type BlobStreamArgs = InferArgs<BlobStreamProcedure>;
type BlobStreamProgress = InferProgress<BlobStreamProcedure>;
type BlobStreamComplete = InferComplete<BlobStreamProcedure>;
type BlobStreamHandler = (
  args: BlobStreamArgs,
  ctx: StreamContext,
) => AsyncGenerator<BlobStreamProgress, BlobStreamComplete, unknown>;

/**
 * Builds the `git.openFileAtHead` call handler.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object so the router stays log-silent. The renderer's ipcCallResult path
 * receives this as an IpcErrResult and unwrapGitResult converts it to a thrown Error.
 */
export function openFileAtHeadHandler(registry: GitRegistry) {
  return withRepo(
    registry,
    c.openFileAtHead.args,
    (repo, { relPath }, ctx) => repo.openFileAtHead(relPath, ctx.signal),
    { refreshStatus: false },
  );
}

/**
 * Builds the `git.getFileBlob` stream handler.
 * Stream handlers propagate GitError through the stream error path — the router
 * serialises them via `serializeError` which already handles GitError.
 */
export function getFileBlobStream(registry: GitRegistry): BlobStreamHandler {
  return async function* ({ workspaceId, ref, relPath }, ctx) {
    const repo = await registry.getOrDetect(workspaceId, ctx.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    return yield* repo.getFileBlob(ref, relPath, ctx.signal);
  };
}
