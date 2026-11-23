import type { FsPreviewParams, FsPreviewResult } from "../../../../shared/fs/protocol";
import type {
  DirEntry,
  ExpectedFileStateContract,
  FileReadBinaryResult,
  FileReadResult,
  FsStat,
  WriteFileResult,
} from "../../../../shared/fs/types";
import type {
  AgentCallOptions,
  ChannelEventCallback,
  ChannelLifecycleCallback,
} from "../../../infra/agent/channel";

export interface FsProvider {
  readonly kind: "local" | "ssh" | "wsl";
  readdir(relPath: string, options?: { includeHidden?: boolean }): Promise<DirEntry[]>;
  readdirNoLinks?(target: { relPath: string } | { absolutePath: string }): Promise<DirEntry[]>;
  readFileNoLinks?(relPath: string): Promise<FileReadResult>;
  readBinaryNoLinks?(relPath: string): Promise<FileReadBinaryResult>;
  readRangeNoLinks?(relPath: string, offset: number, length: number): Promise<FileReadBinaryResult>;
  stat(relPath: string, followSymlink?: boolean): Promise<FsStat>;
  readFile(relPath: string): Promise<FileReadResult>;
  readBinary(relPath: string): Promise<FileReadBinaryResult>;
  readAbsolute(absolutePath: string): Promise<FileReadResult>;
  readAbsoluteBinary(absolutePath: string): Promise<FileReadBinaryResult>;
  readRange(relPath: string, offset: number, length: number): Promise<FileReadBinaryResult>;
  readAbsoluteRange(
    absolutePath: string,
    offset: number,
    length: number,
  ): Promise<FileReadBinaryResult>;
  readPreview?(params: FsPreviewParams): Promise<FsPreviewResult | null>;
  writeFile(
    relPath: string,
    content: string,
    expected?: ExpectedFileStateContract,
    bytes?: string,
  ): Promise<WriteFileResult>;
  createFile(relPath: string): Promise<void>;
  mkdir(relPath: string, recursive?: boolean): Promise<void>;
  unlink(relPath: string): Promise<void>;
  rmdir(relPath: string): Promise<void>;
  rename(fromRelPath: string, toRelPath: string, overwrite?: boolean): Promise<void>;
  copyFile(fromRelPath: string, toRelPath: string, overwrite?: boolean): Promise<void>;
  removeAll(relPath: string): Promise<void>;
  dispose?(): void;
}

export interface AgentBackedProvider extends FsProvider {
  callAgentMethod<TResult = unknown>(
    method: string,
    params?: unknown,
    options?: AgentCallOptions,
  ): Promise<TResult>;
  onAgentEvent(event: string, callback: ChannelEventCallback): () => void;
  onAgentLifecycle(callback: ChannelLifecycleCallback): () => void;
  isAgentAvailable?(): boolean;
}

export function isAgentBackedProvider(provider: FsProvider): provider is AgentBackedProvider {
  return (
    typeof (provider as Partial<AgentBackedProvider>).callAgentMethod === "function" &&
    typeof (provider as Partial<AgentBackedProvider>).onAgentEvent === "function" &&
    typeof (provider as Partial<AgentBackedProvider>).onAgentLifecycle === "function"
  );
}
