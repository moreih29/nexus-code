import type {
  CallArgs,
  CallChannels,
  CallMethods,
  CallReturn,
  IpcRequestId,
  ListenArg as ListenArgs,
  ListenChannels,
  ListenEvents,
} from "./ipc/types";

interface IpcBridge {
  call<C extends CallChannels, M extends CallMethods<C>>(
    channel: C,
    method: M,
    args: CallArgs<C, M>,
    requestId?: IpcRequestId,
  ): Promise<CallReturn<C, M>>;

  cancel(requestId: IpcRequestId): void;

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

declare global {
  interface Window {
    ipc: IpcBridge;
    host: HostBridge;
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
