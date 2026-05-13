import { z } from "zod";
import {
  type DirEntry,
  DirEntrySchema,
  type ExpectedFileStateContract,
  type FileReadResult,
  FileReadResultSchema,
  type FsStat,
  FsStatSchema,
  type WriteFileResult,
  WriteFileResultSchema,
} from "../../../shared/types/fs";
import type { SshErrorCode } from "../../../shared/types/ssh-errors";
import type { AgentChannel } from "../../agent/channel";
import type { AgentBackedProvider } from "./provider";

type ChannelSource = AgentChannel | (() => AgentChannel);

const DirEntryArraySchema = z.array(DirEntrySchema);
const DEFAULT_NOT_WIRED_MESSAGE = "agent fs provider: channel not yet wired";

export interface AgentFsProviderOptions {
  readonly notWiredMessage?: string;
  readonly disposeChannel?: boolean;
}

/**
 * Filesystem provider backed by an agent NDJSON channel. The same provider is
 * used for local and SSH workspaces; transport selection happens before this
 * layer.
 */
export class AgentFsProvider implements AgentBackedProvider {
  private channel: AgentChannel | null = null;

  constructor(
    readonly kind: "local" | "ssh",
    private readonly source?: ChannelSource,
    private readonly options: AgentFsProviderOptions = {},
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

  async readAbsolute(absolutePath: string): Promise<FileReadResult> {
    const result = await this.callAgent("fs.readAbsolute", { absolutePath });
    return parseAgentResult(FileReadResultSchema, result);
  }

  async writeFile(
    relPath: string,
    content: string,
    expected?: ExpectedFileStateContract,
  ): Promise<WriteFileResult> {
    const result = await this.callAgent("fs.writeFile", { relPath, content, expected });
    return parseAgentResult(WriteFileResultSchema, result);
  }

  async createFile(relPath: string): Promise<void> {
    await this.callAgent("fs.createFile", { relPath });
  }

  async mkdir(relPath: string): Promise<void> {
    await this.callAgent("fs.mkdir", { relPath });
  }

  async callAgentMethod<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
    return this.callAgent(method, params) as Promise<TResult>;
  }

  onAgentEvent(event: string, callback: (payload: unknown) => void): () => void {
    return this.getChannel().on(event, callback);
  }

  isAgentAvailable(): boolean {
    return this.channel !== null || this.source !== undefined;
  }

  dispose(): void {
    if (this.options.disposeChannel) {
      this.channel?.dispose();
    }
    this.channel = null;
  }

  private async callAgent(method: string, params: unknown): Promise<unknown> {
    const channel = this.getChannel();
    await channel.ready;
    return channel.call(method, params);
  }

  private getChannel(): AgentChannel {
    if (this.channel) {
      return this.channel;
    }
    if (!this.source) {
      throw new Error(this.options.notWiredMessage ?? DEFAULT_NOT_WIRED_MESSAGE);
    }
    this.channel = typeof this.source === "function" ? this.source() : this.source;
    return this.channel;
  }
}

/**
 * Converts mismatched agent responses into a classified protocol error.
 */
export function parseAgentResult<T>(schema: z.ZodType<T>, result: unknown): T {
  const parsed = schema.safeParse(result);
  if (parsed.success) {
    return parsed.data;
  }

  throw createProtocolError(parsed.error);
}

function createProtocolError(cause: unknown): Error & { code: SshErrorCode } {
  const error = new Error("Remote agent protocol error", { cause }) as Error & {
    code: SshErrorCode;
  };
  error.name = "SshError";
  error.code = "server.protocol-error";
  return error;
}
