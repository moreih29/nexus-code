/**
 * File handlers — bounded HEAD reads and large blob streaming for Git context
 * menu actions.
 */
import {
  ipcContract,
  type InferArgs,
  type InferComplete,
  type InferProgress,
} from "../../../../shared/ipc-contract";
import { GitError } from "../../../git/git-error";
import type { GitRegistry } from "../../../git/git-registry";
import type { CallContext, StreamContext } from "../../router";
import { validateArgs } from "../../router";

const c = ipcContract.git.call;

type BlobStreamProcedure = (typeof ipcContract)["git"]["stream"]["getFileBlob"];
type BlobStreamArgs = InferArgs<BlobStreamProcedure>;
type BlobStreamProgress = InferProgress<BlobStreamProcedure>;
type BlobStreamComplete = InferComplete<BlobStreamProcedure>;
type BlobStreamHandler = (
  args: BlobStreamArgs,
  ctx: StreamContext,
) => AsyncGenerator<BlobStreamProgress, BlobStreamComplete, unknown>;

/** Builds the `git.openFileAtHead` call handler. */
export function openFileAtHeadHandler(registry: GitRegistry) {
  return async (args: unknown, ctx?: CallContext) => {
    const { workspaceId, relPath } = validateArgs(c.openFileAtHead.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    return repo.openFileAtHead(relPath, ctx?.signal);
  };
}

/** Builds the `git.getFileBlob` stream handler. */
export function getFileBlobStream(registry: GitRegistry): BlobStreamHandler {
  return async function* ({ workspaceId, ref, relPath }, ctx) {
    const repo = await registry.getOrDetect(workspaceId, ctx.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    return yield* repo.getFileBlob(ref, relPath, ctx.signal);
  };
}
