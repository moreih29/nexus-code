import { ipcListen } from "../../../ipc/client";
import type { ChatLine } from "../model";
import { chatKey } from "../store";

export interface LineReceiver {
  readonly key: string;
  receive(line: ChatLine): void;
  held(): void;
  resync(): Promise<void>;
}

const primaryReceivers = new Map<string, LineReceiver>();
const otherReceivers = new Map<string, LineReceiver>();
let listening = false;

export function addLineReceiver(receiver: LineReceiver, primary = false): () => void {
  ensureListeners();
  const registry = primary ? primaryReceivers : otherReceivers;
  registry.set(receiver.key, receiver);
  return () => {
    if (registry.get(receiver.key) === receiver) registry.delete(receiver.key);
  };
}

function receiversOf(workspaceId: string): LineReceiver[] {
  const prefix = chatKey(workspaceId, "");
  return [...primaryReceivers.values(), ...otherReceivers.values()].filter((receiver) =>
    receiver.key.startsWith(prefix),
  );
}

function ensureListeners(): void {
  if (listening) return;
  listening = true;
  ipcListen("chat", "line", (line) => {
    const key = chatKey(line.workspaceId, line.tabId);
    (primaryReceivers.get(key) ?? otherReceivers.get(key))?.receive(line as ChatLine);
  });
  ipcListen("chat", "held", ({ workspaceId }) => {
    for (const receiver of receiversOf(workspaceId)) receiver.held();
  });
  ipcListen("chat", "resync", ({ workspaceId }) => {
    for (const receiver of receiversOf(workspaceId)) void receiver.resync();
  });
}
