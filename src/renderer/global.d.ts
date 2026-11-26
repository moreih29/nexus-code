/// <reference types="vite/client" />
/// <reference types="vite-plugin-svgr/client" />
import type { PickedAttachment } from "../shared/fs/picked-attachment";
import type { IpcStreamStartResult } from "../shared/ipc/result";
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
  ): Promise<IpcStreamStartResult>;

  onStreamEvent(streamId: IpcRequestId, callback: (event: IpcStreamEvent) => void): () => void;

  listen<C extends ListenChannels, E extends ListenEvents<C>>(
    channel: C,
    event: E,
    callback: (args: ListenArgs<C, E>) => void,
  ): () => void;
}

interface HostBridge {
  platform: NodeJS.Platform;
  windowsStore?: boolean;
  transparentWindow?: boolean;
  opaqueWindow?: boolean;
}

interface FilesBridge {
  getPathForFile(file: File): string;
  readPickedAttachment(file: File): Promise<PickedAttachment | null>;
}

declare global {
  interface Window {
    ipc: IpcBridge;
    host: HostBridge;
    files: FilesBridge;
  }

  interface ImportMetaEnv {
    readonly DEV: boolean;
    readonly PROD: boolean;
    readonly MODE: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}
