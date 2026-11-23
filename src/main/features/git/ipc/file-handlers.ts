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

export function openFileAtHeadHandler(registry: GitRegistry) {
  return withRepo(
    registry,
    c.openFileAtHead.args,
    (repo, { relPath }, ctx) => repo.openFileAtHead(relPath, ctx.signal),
    { refreshStatus: false },
  );
}

export function getFileBlobStream(registry: GitRegistry): BlobStreamHandler {
  return async function* ({ workspaceId, ref, relPath }, ctx) {
    const repo = await registry.getOrDetect(workspaceId, ctx.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    return yield* repo.getFileBlob(ref, relPath, ctx.signal);
  };
}
