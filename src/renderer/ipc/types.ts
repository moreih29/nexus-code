// Shared IPC type derivations from the contract.
// Consumed by both ipc/client.ts and the ambient window.ipc declaration in global.d.ts.

import type { InferArgs, InferReturn, ipcContract } from "../../shared/ipc-contract";

export type Contract = typeof ipcContract;

export type CallChannels = {
  [C in keyof Contract]: Contract[C] extends { call: Record<string, unknown> } ? C : never;
}[keyof Contract];

export type ListenChannels = {
  [C in keyof Contract]: Contract[C] extends { listen: Record<string, unknown> } ? C : never;
}[keyof Contract];

export type CallMethods<C extends CallChannels> = keyof Contract[C]["call"] & string;
export type ListenEvents<C extends ListenChannels> = keyof Contract[C]["listen"] & string;

export type CallArgs<C extends CallChannels, M extends CallMethods<C>> = InferArgs<
  Contract[C]["call"][M]
>;

export type CallReturn<C extends CallChannels, M extends CallMethods<C>> = InferReturn<
  Contract[C]["call"][M]
>;

export type ListenArg<C extends ListenChannels, E extends ListenEvents<C>> = InferArgs<
  Contract[C]["listen"][E]
>;

export type IpcRequestId = string;
