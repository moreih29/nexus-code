import { ipcListen } from "../../../ipc/client";
import type { ChatLine } from "../model";
import { chatKey } from "../store";

/** A tab that receives its program's log and reconnect events. */
export interface LineReceiver {
  readonly key: string;
  receive(line: ChatLine): void;
  held(): void;
  resync(): Promise<void>;
}

const primaryReceivers = new Map<string, LineReceiver>();
const otherReceivers = new Map<string, LineReceiver>();
let listening = false;

/** Registers a receiver until the returned cleanup is called. */
export function addLineReceiver(receiver: LineReceiver, primary = false): () => void {
  ensureListeners();
  const registry = primary ? primaryReceivers : otherReceivers;
  registry.set(receiver.key, receiver);
  return () => {
    if (registry.get(receiver.key) === receiver) registry.delete(receiver.key);
  };
}

/** Selects the tabs to notify for a workspace-level agent event. */
function receiversOf(workspaceId: string): LineReceiver[] {
  const prefix = chatKey(workspaceId, "");
  return [...primaryReceivers.values(), ...otherReceivers.values()].filter((receiver) =>
    receiver.key.startsWith(prefix),
  );
}

/** Installs the window's shared IPC listeners once. */
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
