// Shared IPC type derivations from the contract.
// Consumed by both ipc/client.ts and the ambient window.ipc declaration in global.d.ts.

import type {
  InferArgs,
  InferComplete,
  InferProgress,
  InferReturn,
  ipcContract,
} from "../../shared/ipc/ipc-contract";

export type Contract = typeof ipcContract;

type StreamProcedures<C extends keyof Contract> = Contract[C] extends { stream: infer Procedures }
  ? Procedures
  : never;

type StreamProcedureFor<C extends StreamChannels, M extends StreamMethods<C>> =
  StreamProcedures<C> extends { readonly [K in M]: infer Procedure } ? Procedure : never;

export type CallChannels = {
  [C in keyof Contract]: Contract[C] extends { call: Record<string, unknown> } ? C : never;
}[keyof Contract];

export type ListenChannels = {
  [C in keyof Contract]: Contract[C] extends { listen: Record<string, unknown> } ? C : never;
}[keyof Contract];

export type StreamChannels = {
  [C in keyof Contract]: [StreamProcedures<C>] extends [never] ? never : C;
}[keyof Contract];

export type CallMethods<C extends CallChannels> = keyof Contract[C]["call"] & string;
export type ListenEvents<C extends ListenChannels> = keyof Contract[C]["listen"] & string;
export type StreamMethods<C extends StreamChannels> = keyof StreamProcedures<C> & string;

export type CallArgs<C extends CallChannels, M extends CallMethods<C>> = InferArgs<
  Contract[C]["call"][M]
>;

export type CallReturn<C extends CallChannels, M extends CallMethods<C>> = InferReturn<
  Contract[C]["call"][M]
>;

export type ListenArg<C extends ListenChannels, E extends ListenEvents<C>> = InferArgs<
  Contract[C]["listen"][E]
>;

export type StreamArgs<C extends StreamChannels, M extends StreamMethods<C>> = InferArgs<
  StreamProcedureFor<C, M>
>;

export type StreamProgress<C extends StreamChannels, M extends StreamMethods<C>> = InferProgress<
  StreamProcedureFor<C, M>
>;

export type StreamComplete<C extends StreamChannels, M extends StreamMethods<C>> = InferComplete<
  StreamProcedureFor<C, M>
>;

export type IpcRequestId = string;
