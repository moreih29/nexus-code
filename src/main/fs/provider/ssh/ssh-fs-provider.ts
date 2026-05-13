import { z } from "zod";
import {
  type DirEntry,
  DirEntrySchema,
  type FileReadResult,
  FileReadResultSchema,
  type FsStat,
  FsStatSchema,
} from "../../../../shared/types/fs";
import type { SshErrorCode } from "../../../../shared/types/ssh-errors";
import type { WorkspaceLocation } from "../../../../shared/types/workspace";
import type { SshChannel } from "../../../agent/ssh-channel";
import type { FsReadProvider } from "../types";

type SshWorkspaceLocation = Extract<WorkspaceLocation, { kind: "ssh" }>;

const SSH_FS_PROVIDER_NOT_WIRED = "ssh fs provider: channel not yet wired";
const DirEntryArraySchema = z.array(DirEntrySchema);

/**
 * SSH read provider that delegates workspace-relative reads to a remote agent channel.
 */
export class SshFsProvider implements FsReadProvider {
  readonly kind = "ssh";

  constructor(
    readonly location: SshWorkspaceLocation,
    private readonly channel?: SshChannel,
  ) {}

  async readdir(relPath: string): Promise<DirEntry[]> {
    const result = await this.callAgent("fs.readdir", { relPath });
    return parseAgentResult(DirEntryArraySchema, result);
  }

  async stat(relPath: string): Promise<FsStat> {
    const result = await this.callAgent("fs.stat", { relPath });
    return parseAgentResult(FsStatSchema, result);
  }

  async readFile(relPath: string): Promise<FileReadResult> {
    const result = await this.callAgent("fs.readFile", { relPath });
    return parseAgentResult(FileReadResultSchema, result);
  }

  /**
   * Calls the remote agent only after activation has supplied a channel.
   */
  private callAgent(method: string, params: { readonly relPath: string }): Promise<unknown> {
    if (!this.channel) {
      return Promise.reject(new Error(SSH_FS_PROVIDER_NOT_WIRED));
    }

    return this.channel.call(method, params);
  }
}

/**
 * Converts mismatched remote responses into a classified agent protocol error.
 */
function parseAgentResult<T>(schema: z.ZodType<T>, result: unknown): T {
  const parsed = schema.safeParse(result);
  if (parsed.success) {
    return parsed.data;
  }

  throw createProtocolError(parsed.error);
}

/**
 * Creates the same classified error shape used by the SSH transport layer.
 */
function createProtocolError(cause: unknown): Error & { code: SshErrorCode } {
  const error = new Error("Remote agent protocol error", { cause }) as Error & {
    code: SshErrorCode;
  };
  error.name = "SshError";
  error.code = "server.protocol-error";
  return error;
}
