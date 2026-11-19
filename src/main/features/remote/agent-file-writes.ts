import { z } from "zod";
import { RpcErrorCode } from "../../../../packages/remote-protocol/src";
import { parseAgentResult } from "../fs/bridge/agent-provider";
import type { AgentBackedProvider } from "../fs/bridge/provider";
import { filePathRules, validFileName } from "./file-io";
import { workspaceWritePath } from "./file-writes";
import { RpcFailure } from "./room";

const pathResult = z.object({ path: z.string() });

export class AgentFileWrites {
  private readonly relPath: string;

  constructor(
    private readonly fs: AgentBackedProvider,
    root: string,
    path: string,
    private readonly directory: boolean,
  ) {
    const rel = workspaceWritePath(root, path, directory);
    if (rel && !rel.split("/").every((part) => validFileName(part, filePathRules(root)))) {
      throw new RpcFailure(RpcErrorCode.InvalidParams, "the destination needs a file name");
    }
    this.relPath = rel;
  }

  async resolve(): Promise<string> {
    const result = await this.call("resolve", { relPath: this.relPath, directory: this.directory });
    return parseAgentResult(pathResult, result).path;
  }

  async mkdir(expectedPath: string): Promise<{ path: string }> {
    await this.call("mkdir", { relPath: this.relPath, expectedPath });
    return { path: expectedPath };
  }

  async begin(uploadId: string, expectedPath: string, size: number): Promise<void> {
    await this.call("begin", { relPath: this.relPath, expectedPath, uploadId, size });
  }

  async chunk(uploadId: string, offset: number, data: string): Promise<void> {
    await this.call("chunk", { uploadId, offset, data });
  }

  async verify(uploadId: string, sha256: string): Promise<void> {
    await this.call("verify", { uploadId, sha256 });
  }

  async commit(uploadId: string): Promise<void> {
    await this.call("commit", { uploadId });
  }

  async abort(uploadId: string): Promise<void> {
    await this.call("abort", { uploadId });
  }

  private async call(method: string, params: object): Promise<unknown> {
    try {
      return await this.fs.callAgentMethod(`fs.upload.${method}`, params);
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      const message = error instanceof Error ? error.message : String(error);
      switch (code) {
        case "unsupported-method":
          throw new RpcFailure(
            RpcErrorCode.Unavailable,
            "the remote filesystem agent must be updated to write files",
          );
        case "OUT_OF_WORKSPACE":
        case "PERMISSION_DENIED":
          throw new RpcFailure(RpcErrorCode.Forbidden, message);
        case "NOT_FOUND":
          throw new RpcFailure(RpcErrorCode.NotFound, message);
        case "IS_DIRECTORY":
        case "NOT_DIRECTORY":
        case "server.protocol-error":
          throw new RpcFailure(RpcErrorCode.InvalidParams, message);
        case "NO_SPACE":
          throw new RpcFailure(
            RpcErrorCode.Unavailable,
            "the destination has insufficient disk space",
          );
        default:
          throw new RpcFailure(RpcErrorCode.Unavailable, message);
      }
    }
  }
}
