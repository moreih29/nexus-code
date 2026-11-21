import type { RelaySender } from "../../../../shared/chat/relay";
import { createLogger } from "../../../../shared/log/renderer";
import { useTabsStore } from "../../../state/stores/tabs";
import type { AgentTabController } from "../agent-tab";
import type { ImageBlock } from "../model";
import { chatKey, unseenSends, useChatStore } from "../store";

const log = createLogger("chat");

export interface PeerSubmission {
  clientNonce: string;
  clientDeviceId: string;
  /** A Claude stdin write has returned successfully. */
  written?: boolean;
}

const receiptIds = new Map<string, { id: string; expiresAt: number }>();

const MAX_RECEIPTS = 4096;

const RECEIPT_TTL_MS = 30 * 60_000;

/** Resolves the existing remote `at` receipt to the exact submission on this tab. */
export function submissionAt(workspaceId: string, tabId: string, at: number): string | undefined {
  const key = `${chatKey(workspaceId, tabId)}:${at}`;
  const receipt = receiptIds.get(key);
  if (!receipt) return undefined;
  if (receipt.expiresAt > Date.now()) return receipt.id;
  receiptIds.delete(key);
  return undefined;
}

/** Keeps remote receipts for the lifetime of a CLI wait, within a fixed cap. */
function rememberReceipt(key: string, at: number, id: string): void {
  if (receiptIds.size === MAX_RECEIPTS) {
    const oldest = receiptIds.keys().next().value;
    if (oldest !== undefined) receiptIds.delete(oldest);
  }
  receiptIds.set(`${key}:${at}`, { id, expiresAt: Date.now() + RECEIPT_TTL_MS });
}

function userMessages(key: string): number {
  const chat = useChatStore.getState().tabs[key];
  return chat ? chat.model.items.filter((item) => item.kind === "user").length : 0;
}

/** Whether a message sent to the tab is yet to show in its conversation. */
export function sendUnseen(workspaceId: string, tabId: string): boolean {
  const key = chatKey(workspaceId, tabId);
  const send = unseenSends.get(key);
  if (!send) return false;
  if (userMessages(key) <= send.before) return true;
  unseenSends.delete(key);
  return false;
}

/**
 * Sends `text` to a tab, starting its program if it is not running; the tab
 * counts as working from now, not only once the message shows. `from`: the
 * agent that sent it through the nexus command, when one did.
 */
export async function sendToAgentTab(
  workspaceId: string,
  tabId: string,
  target: AgentTabController,
  text: string,
  from?: RelaySender,
  images: ImageBlock[] = [],
  when: SendTiming = "next",
  device?: string,
  submission?: PeerSubmission,
  wait?: { receiptAt?: number },
): Promise<{ heldId?: string; itemKey?: string; submissionId?: string }> {
  const { controller } = target;
  const key = chatKey(workspaceId, tabId);
  // Working from now, though the program may be starting and a conversation
  // resumed after a restart still coming in: its messages are counted only
  // once it is in, or they would pass for the one sent.
  const unseen = { before: Number.POSITIVE_INFINITY };
  unseenSends.set(key, unseen);
  const clear = () => {
    if (unseenSends.get(key) === unseen) unseenSends.delete(key);
  };
  try {
    await controller.prepareSend();
    unseen.before = userMessages(key);
    const id = submission || wait ? crypto.randomUUID() : undefined;
    const tracked = wait && id ? { submissionId: id } : {};
    if (id && wait?.receiptAt !== undefined) rememberReceipt(key, wait.receiptAt, id);
    if (id && submission) {
      const tabs = useTabsStore.getState();
      const tab = tabs.byWorkspace[workspaceId]?.[tabId];
      if (tab?.type !== target.agent) throw new Error("the tab closed");
      tabs.addChatPeerSubmission(workspaceId, tabId, id, submission);
      const updated = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
      if (updated?.type !== target.agent) throw new Error("the tab closed");
      useChatStore.getState().update(key, (prev) => ({
        ...prev,
        peerSubmissions: updated.props.peerSubmissions ?? { [id]: submission },
      }));
    }
    if (when === "after" && (!id || controller.state.model.running)) {
      const heldId = controller.enqueue(text, images, from, device, id);
      // Held, it is not sent yet: the chat is not waiting on it.
      if (heldId) clear();
      return heldId ? { heldId, ...tracked } : tracked;
    }
    if (target.agent === "codex") {
      const heldId = await target.controller.sendWithTiming(
        text,
        images,
        when === "now" ? "now" : "next",
        from,
        device,
        id,
      );
      if (heldId) {
        clear();
        return { heldId, ...tracked };
      }
    } else if (when === "now") {
      await target.controller.sendNow(text, images, from, id);
    } else {
      await target.controller.send(text, images, from, id);
    }
    return id && submission && target.agent === "codex"
      ? { itemKey: `u-peer-${id}`, ...tracked }
      : tracked;
  } catch (err) {
    clear();
    throw err;
  }
}

/**
 * When a message sent during a turn goes, as the composer's keys have it:
 * next (↩), now (⌘↩), after the turn (⌘⇧↩).
 */
export type SendTiming = "next" | "now" | "after";

/** Opens the program and sends the first message while marking the tab as working. */
export async function sendFirstMessage(
  workspaceId: string,
  tabId: string,
  target: AgentTabController,
  text: string,
  from?: RelaySender,
): Promise<void> {
  const key = chatKey(workspaceId, tabId);
  // Working from now: opening the program comes before the message.
  const opening = { before: Number.POSITIVE_INFINITY };
  unseenSends.set(key, opening);
  try {
    await target.controller.open();
    const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
    if (tab?.type !== target.agent) throw new Error("the tab closed");
    await sendToAgentTab(workspaceId, tabId, target, text, from);
  } catch (error) {
    if (unseenSends.get(key) === opening) unseenSends.delete(key);
    log.warn(`first message to ${target.agent} tab not sent: ${(error as Error).message}`);
    throw error;
  }
}
