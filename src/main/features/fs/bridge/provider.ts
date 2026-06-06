import type {
  DirEntry,
  ExpectedFileStateContract,
  FileReadBinaryResult,
  FileReadResult,
  FsStat,
  WriteFileResult,
} from "../../../../shared/fs/types";
import type {
  ChannelEventCallback,
  ChannelLifecycleCallback,
} from "../../../infra/agent/channel";

/**
 * Filesystem provider bound to one workspace-scoped agent.
 */
export interface FsProvider {
  readonly kind: "local" | "ssh";
  readdir(relPath: string): Promise<DirEntry[]>;
  stat(relPath: string): Promise<FsStat>;
  readFile(relPath: string): Promise<FileReadResult>;
  /**
   * Read a workspace-relative file as base64-encoded bytes. Used for binary
   * content (images, etc.) that cannot ride fs.readFile's UTF-8 string body.
   */
  readBinary(relPath: string): Promise<FileReadBinaryResult>;
  readAbsolute(absolutePath: string): Promise<FileReadResult>;
  writeFile(
    relPath: string,
    content: string,
    expected?: ExpectedFileStateContract,
  ): Promise<WriteFileResult>;
  createFile(relPath: string): Promise<void>;
  /**
   * Create a directory. `recursive` opts into os.MkdirAll on the agent so
   * intermediate segments are materialised (needed for the renderer's
   * nested-path inline-create — e.g. "src/foo/bar"). Default is single-level
   * mkdir so unrelated callers still get NOT_FOUND for missing parents.
   */
  mkdir(relPath: string, recursive?: boolean): Promise<void>;
  unlink(relPath: string): Promise<void>;
  rmdir(relPath: string): Promise<void>;
  rename(fromRelPath: string, toRelPath: string, overwrite?: boolean): Promise<void>;
  copyFile(fromRelPath: string, toRelPath: string, overwrite?: boolean): Promise<void>;
  removeAll(relPath: string): Promise<void>;
  dispose?(): void;
}

export interface AgentBackedProvider extends FsProvider {
  callAgentMethod<TResult = unknown>(method: string, params?: unknown): Promise<TResult>;
  onAgentEvent(event: string, callback: ChannelEventCallback): () => void;
  /**
   * Subscribes to channel lifecycle transitions. Watch bridges use the
   * `ready` event (successful reconnect handshake) to replay agent-side
   * fs.watch / git.watch registrations onto the replacement agent process.
   */
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
