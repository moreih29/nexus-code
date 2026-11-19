import type { RelaySender } from "../../../../shared/chat/relay";
import { createLogger } from "../../../../shared/log/renderer";
import { useTabsStore } from "../../../state/stores/tabs";
import type { AgentTabController } from "../agent-tab";
import type { ImageBlock } from "../model";
import { chatKey, useChatStore } from "../store";

const log = createLogger("chat");

export interface PeerSubmission {
  clientNonce: string;
  clientDeviceId: string;
  /** A Claude stdin write has returned successfully. */
  written?: boolean;
}

/**
 * Messages sent to tabs that their conversation does not show yet, by chat
 * key: how many messages of the user's it showed when one was sent. Until it
 * shows more, the tab counts as working, though no turn has begun.
 */
const unseenSends = new Map<string, number>();

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
  const before = unseenSends.get(key);
  if (before === undefined) return false;
  if (userMessages(key) <= before) return true;
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
  unseenSends.set(key, Number.POSITIVE_INFINITY);
  try {
    await controller.prepareSend();
    unseenSends.set(key, userMessages(key));
    const id = submission || wait ? crypto.randomUUID() : undefined;
    const tracked = wait && id ? { submissionId: id } : {};
    if (id && wait?.receiptAt !== undefined) rememberReceipt(key, wait.receiptAt, id);
    if (id && submission) {
      useTabsStore.getState().addChatPeerSubmission(workspaceId, tabId, id, submission);
      const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
      const recent =
        tab?.type === "claude" || tab?.type === "codex" ? tab.props.peerSubmissions : undefined;
      useChatStore.getState().update(key, (prev) => ({
        ...prev,
        peerSubmissions: recent ?? { [id]: submission },
      }));
    }
    if (when === "after" && (!id || controller.state.model.running)) {
      const heldId = controller.enqueue(text, images, from, device, id);
      // Held, it is not sent yet: the chat is not waiting on it.
      if (heldId) unseenSends.delete(key);
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
        unseenSends.delete(key);
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
    unseenSends.delete(key);
    throw err;
  }
}

/**
 * When a message sent during a turn goes, as the composer's keys have it:
 * next (↩), now (⌘↩), after the turn (⌘⇧↩).
 */
export type SendTiming = "next" | "now" | "after";

/** Opens the program and sends the first message while marking the tab as working. */
export function sendFirstMessage(
  workspaceId: string,
  tabId: string,
  target: AgentTabController,
  text: string,
  from?: RelaySender,
): void {
  const key = chatKey(workspaceId, tabId);
  // Working from now: opening the program comes before the message.
  unseenSends.set(key, 0);
  void target.controller
    .open()
    .then(() => sendToAgentTab(workspaceId, tabId, target, text, from))
    .catch((err: Error) => {
      unseenSends.delete(key);
      log.warn(`first message to ${target.agent} tab not sent: ${err.message}`);
    });
}
