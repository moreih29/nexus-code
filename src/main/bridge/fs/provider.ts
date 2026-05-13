import type {
  DirEntry,
  ExpectedFileStateContract,
  FileReadResult,
  FsStat,
  WriteFileResult,
} from "../../../shared/types/fs";
import type { ChannelEventCallback } from "../../agent/channel";

/**
 * Filesystem provider bound to one workspace-scoped agent.
 */
export interface FsProvider {
  readonly kind: "local" | "ssh";
  readdir(relPath: string): Promise<DirEntry[]>;
  stat(relPath: string): Promise<FsStat>;
  readFile(relPath: string): Promise<FileReadResult>;
  readAbsolute(absolutePath: string): Promise<FileReadResult>;
  writeFile(
    relPath: string,
    content: string,
    expected?: ExpectedFileStateContract,
  ): Promise<WriteFileResult>;
  createFile(relPath: string): Promise<void>;
  mkdir(relPath: string): Promise<void>;
  unlink(relPath: string): Promise<void>;
  rmdir(relPath: string): Promise<void>;
  rename(fromRelPath: string, toRelPath: string): Promise<void>;
  dispose?(): void;
}

export interface AgentBackedProvider extends FsProvider {
  callAgentMethod<TResult = unknown>(method: string, params?: unknown): Promise<TResult>;
  onAgentEvent(event: string, callback: ChannelEventCallback): () => void;
  isAgentAvailable?(): boolean;
}

export function isAgentBackedProvider(provider: FsProvider): provider is AgentBackedProvider {
  return (
    typeof (provider as Partial<AgentBackedProvider>).callAgentMethod === "function" &&
    typeof (provider as Partial<AgentBackedProvider>).onAgentEvent === "function"
  );
}
