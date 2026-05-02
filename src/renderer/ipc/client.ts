import type { ipcContract } from "../../shared/ipc-contract";
import type { InferArgs, InferReturn } from "../../shared/ipc-contract";

type Contract = typeof ipcContract;

type CallChannels = {
  [C in keyof Contract]: Contract[C] extends { call: Record<string, unknown> } ? C : never;
}[keyof Contract];

type ListenChannels = {
  [C in keyof Contract]: Contract[C] extends { listen: Record<string, unknown> } ? C : never;
}[keyof Contract];

type CallMethods<C extends CallChannels> = keyof Contract[C]["call"] & string;
type ListenEvents<C extends ListenChannels> = keyof Contract[C]["listen"] & string;

type CallArgs<C extends CallChannels, M extends CallMethods<C>> = InferArgs<
  Contract[C]["call"][M]
>;

type CallReturn<C extends CallChannels, M extends CallMethods<C>> = InferReturn<
  Contract[C]["call"][M]
>;

type ListenArg<C extends ListenChannels, E extends ListenEvents<C>> = InferArgs<
  Contract[C]["listen"][E]
>;

export function ipcCall<C extends CallChannels, M extends CallMethods<C>>(
  channel: C,
  method: M,
  args: CallArgs<C, M>
): Promise<CallReturn<C, M>> {
  return window.ipc.call(channel, method, args) as Promise<CallReturn<C, M>>;
}

export function ipcListen<C extends ListenChannels, E extends ListenEvents<C>>(
  channel: C,
  event: E,
  callback: (args: ListenArg<C, E>) => void
): () => void {
  const cb = callback as (args: ListenArg<C, E>) => void;
  window.ipc.listen(channel, event, cb as Parameters<typeof window.ipc.listen>[2]);
  return () => {
    window.ipc.off(channel, event, cb as Parameters<typeof window.ipc.off>[2]);
  };
}
