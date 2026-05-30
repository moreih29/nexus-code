/// <reference types="vite/client" />
/// <reference types="vite-plugin-svgr/client" />
import type {
  CallArgs,
  CallChannels,
  CallMethods,
  CallReturn,
  IpcRequestId,
  ListenArg as ListenArgs,
  ListenChannels,
  ListenEvents,
  StreamArgs,
  StreamChannels,
  StreamMethods,
} from "./ipc/types";

type IpcStreamEvent =
  | { streamId: IpcRequestId; kind: "progress"; data: unknown }
  | { streamId: IpcRequestId; kind: "complete"; data: unknown }
  | { streamId: IpcRequestId; kind: "error"; data: unknown };

interface IpcBridge {
  call<C extends CallChannels, M extends CallMethods<C>>(
    channel: C,
    method: M,
    args: CallArgs<C, M>,
    requestId?: IpcRequestId,
  ): Promise<CallReturn<C, M>>;

  cancel(requestId: IpcRequestId): void;

  streamStart<C extends StreamChannels, M extends StreamMethods<C>>(
    channel: C,
    method: M,
    args: StreamArgs<C, M>,
  ): Promise<{ streamId: IpcRequestId }>;

  onStreamEvent(streamId: IpcRequestId, callback: (event: IpcStreamEvent) => void): () => void;

  listen<C extends ListenChannels, E extends ListenEvents<C>>(
    channel: C,
    event: E,
    callback: (args: ListenArgs<C, E>) => void,
  ): void;

  off<C extends ListenChannels, E extends ListenEvents<C>>(
    channel: C,
    event: E,
    callback: (args: ListenArgs<C, E>) => void,
  ): void;
}

interface HostBridge {
  /** process.platform from the preload — "darwin" | "win32" | "linux" | ... */
  platform: NodeJS.Platform;
}

interface FilesBridge {
  /**
   * Resolve the absolute filesystem path of a File obtained from a drag-and-drop
   * (or file input) DataTransfer. Backed by Electron's `webUtils.getPathForFile`
   * — the supported replacement for the removed `File.path` property.
   */
  getPathForFile(file: File): string;
}

declare global {
  interface Window {
    ipc: IpcBridge;
    host: HostBridge;
    files: FilesBridge;
  }

  // Vite env variables used in renderer.
  interface ImportMetaEnv {
    readonly DEV: boolean;
    readonly PROD: boolean;
    readonly MODE: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}
