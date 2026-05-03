import type { InferArgs, InferReturn, ipcContract } from "../shared/ipc-contract";

type Contract = typeof ipcContract;

type CallChannels = {
  [C in keyof Contract]: Contract[C] extends { call: Record<string, unknown> } ? C : never;
}[keyof Contract];

type ListenChannels = {
  [C in keyof Contract]: Contract[C] extends { listen: Record<string, unknown> } ? C : never;
}[keyof Contract];

type CallMethods<C extends CallChannels> = keyof Contract[C]["call"] & string;
type ListenEvents<C extends ListenChannels> = keyof Contract[C]["listen"] & string;

type CallArgs<C extends CallChannels, M extends CallMethods<C>> = InferArgs<Contract[C]["call"][M]>;

type CallReturn<C extends CallChannels, M extends CallMethods<C>> = InferReturn<
  Contract[C]["call"][M]
>;

type ListenArgs<C extends ListenChannels, E extends ListenEvents<C>> = InferArgs<
  Contract[C]["listen"][E]
>;

interface IpcBridge {
  call<C extends CallChannels, M extends CallMethods<C>>(
    channel: C,
    method: M,
    args: CallArgs<C, M>,
  ): Promise<CallReturn<C, M>>;

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
