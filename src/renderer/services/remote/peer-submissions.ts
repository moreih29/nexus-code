import { create } from "zustand";
import type { ChatPanel, ViewItem } from "../../../../packages/remote-protocol/src";
import type { ComposerAttachment } from "../../components/chat/composer";
import { splitAttachments } from "../chat/composer-input";
import type { ImageBlock, UserItem } from "../chat/model";
import type { ChatRef } from "./peer-chat";

export interface PeerSubmission {
  nonce: string;
  clientDeviceId?: string;
  text: string;
  images: ImageBlock[];
  files: readonly ComposerAttachment[];
  timing?: "now" | "after";
  baseline: number;
  submittedAt: number;
  at: number;
  status: NonNullable<UserItem["optimistic"]>["status"];
  error?: string;
  heldId?: string;
  itemKey?: string;
  provisionalEcho?: string;
}

type Echo = { index: number; item: ViewItem };
const keyOf = ({ deviceId, workspaceId, tabId }: ChatRef) =>
  JSON.stringify([deviceId, workspaceId, tabId]);
const NONE: readonly PeerSubmission[] = [];
const RECENT_KEYS = 128;
const RECENT_CHATS = 64;
const ACCEPTED_GRACE_MS = 30_000;
const MAX_PER_CHAT = 8;
const MAX_PENDING = 64;

interface Evidence {
  userKeys: Set<string>;
  heldIds: Set<string>;
}

const useSubmissions = create<{ byChat: Record<string, readonly PeerSubmission[]> }>(() => ({
  byChat: {},
}));

const evidence = new Map<string, Evidence>();

function update(
  ref: ChatRef,
  change: (entries: readonly PeerSubmission[]) => readonly PeerSubmission[],
) {
  const key = keyOf(ref);
  useSubmissions.setState((state) => {
    const before = state.byChat[key] ?? NONE;
    const entries = change(before);
    if (entries === before) return state;
    if (entries.length) return { byChat: { ...state.byChat, [key]: entries } };
    const { [key]: _old, ...byChat } = state.byChat;
    return { byChat };
  });
}

export function peerSubmissionHasRoom(ref: ChatRef): boolean {
  return (
    peerSubmissionsOf(ref).length < MAX_PER_CHAT &&
    Object.values(useSubmissions.getState().byChat).reduce(
      (count, entries) => count + entries.length,
      0,
    ) < MAX_PENDING
  );
}

export function forgetPeerSubmissions(ref: ChatRef): void {
  evidence.delete(keyOf(ref));
  update(ref, () => NONE);
}

export function beginPeerSubmission(
  ref: ChatRef,
  input: Pick<
    PeerSubmission,
    "text" | "images" | "files" | "timing" | "baseline" | "clientDeviceId"
  >,
): PeerSubmission {
  const entry: PeerSubmission = {
    ...input,
    nonce: crypto.randomUUID(),
    submittedAt: performance.now(),
    at: Date.now(),
    status: "sending",
  };
  update(ref, (entries) => [...entries, entry]);
  return entry;
}

export function settlePeerSubmission(
  ref: ChatRef,
  entry: PeerSubmission,
  result:
    | { status: "accepted"; heldId?: string; itemKey?: string }
    | { status: "failed" | "unconfirmed"; error: string },
): void {
  if (import.meta.env.DEV) {
    performance.clearMeasures("peer-chat.submit-to-response");
    performance.measure("peer-chat.submit-to-response", {
      start: entry.submittedAt,
      end: performance.now(),
    });
  }
  const seen = evidence.get(keyOf(ref));
  update(ref, (entries) => {
    if (!entries.some((pending) => pending.nonce === entry.nonce)) return entries;
    return entries.flatMap((pending) => {
      if (pending.nonce !== entry.nonce) return [pending];
      if (result.status === "unconfirmed" && pending.provisionalEcho) return [];
      if (result.status === "accepted") {
        if (!result.heldId && pending.provisionalEcho) return [];
        if (result.heldId && seen?.heldIds.has(result.heldId)) return [];
        if (result.itemKey && seen?.userKeys.has(result.itemKey)) return [];
      }
      return [{ ...pending, ...result }];
    });
  });
  if (result.status === "accepted") {
    const nonce = entry.nonce;
    if (peerSubmissionsOf(ref).some((pending) => pending.nonce === nonce)) {
      setTimeout(
        () =>
          update(ref, (entries) => {
            const kept = entries.filter(
              (pending) => pending.nonce !== nonce || pending.status !== "accepted",
            );
            return kept.length === entries.length ? entries : kept;
          }),
        ACCEPTED_GRACE_MS,
      );
    }
  }
}

export function peerSubmissionsOf(ref: ChatRef): readonly PeerSubmission[] {
  return useSubmissions.getState().byChat[keyOf(ref)] ?? NONE;
}

export function usePeerSubmissions(ref: ChatRef): readonly PeerSubmission[] {
  return useSubmissions((state) => state.byChat[keyOf(ref)] ?? NONE);
}

export function recoverPeerSubmission(ref: ChatRef, nonce: string): PeerSubmission | undefined {
  const entry = peerSubmissionsOf(ref).find((p) => p.nonce === nonce);
  if (!entry || (entry.status !== "failed" && entry.status !== "unconfirmed")) return undefined;
  update(ref, (entries) => entries.filter((pending) => pending !== entry));
  return entry;
}

export function previewOf(entry: PeerSubmission): UserItem {
  return {
    key: `pending:${entry.nonce}`,
    kind: "user",
    state: "sent",
    at: entry.at,
    text: entry.text,
    images: entry.images,
    optimistic: {
      status: entry.status,
      queued:
        entry.heldId !== undefined || (entry.status === "sending" && entry.timing === "after"),
      fileNames: entry.files.map(({ file }) => file.name),
      submittedAt: entry.submittedAt,
      error: entry.error,
    },
  };
}

export function observePeerEchoes(
  ref: ChatRef,
  echoes: readonly Echo[],
  held?: ChatPanel["held"],
): void {
  const key = keyOf(ref);
  let seen = evidence.get(key);
  if (!seen) {
    seen = { userKeys: new Set(), heldIds: new Set() };
    if (evidence.size >= RECENT_CHATS) {
      const oldest = evidence.keys().next().value;
      if (oldest) evidence.delete(oldest);
    }
    evidence.set(key, seen);
  }
  const { userKeys, heldIds } = seen;
  const pending = peerSubmissionsOf(ref);
  const matched = new Set<string>();
  const provisional = new Map<string, string>();
  const byIdentity = new Map(
    pending
      .filter((entry) => entry.clientDeviceId)
      .map((entry) => [`${entry.clientDeviceId}/${entry.nonce}`, entry]),
  );
  const byItem = new Map(
    pending.filter((entry) => entry.itemKey).map((entry) => [entry.itemKey, entry]),
  );
  const byHeld = new Map(
    pending.filter((entry) => entry.heldId).map((entry) => [entry.heldId, entry]),
  );
  for (const { index, item } of echoes) {
    if (
      item.kind !== "user" ||
      !("images" in item) ||
      !Array.isArray(item.images) ||
      typeof item.text !== "string"
    )
      continue;
    const { text, images } = item;
    const fresh = !userKeys.has(item.key);
    userKeys.add(item.key);
    const exact =
      item.clientNonce && item.clientDeviceId
        ? byIdentity.get(`${item.clientDeviceId}/${item.clientNonce}`)
        : byItem.get(item.key);
    if (exact) {
      matched.add(exact.nonce);
      continue;
    }
    if (!fresh || item.clientNonce || !pending.length) continue;
    const legacy = pending.find((entry) => {
      if (
        entry.clientDeviceId ||
        entry.provisionalEcho ||
        provisional.has(entry.nonce) ||
        matched.has(entry.nonce) ||
        index < entry.baseline ||
        (entry.status !== "accepted" && entry.status !== "sending") ||
        entry.images.length !== images.length
      )
        return false;
      if (entry.files.length === 0) return entry.text.trim() === text.trim();
      const parts = splitAttachments(text);
      return parts.text.trim() === entry.text.trim() && parts.files.length === entry.files.length;
    });
    if (legacy?.status === "accepted") matched.add(legacy.nonce);
    else if (legacy) provisional.set(legacy.nonce, item.key);
  }
  if (held) {
    heldIds.clear();
    for (const item of held) {
      heldIds.add(item.id);
      const exact =
        item.clientDeviceId && item.clientNonce
          ? byIdentity.get(`${item.clientDeviceId}/${item.clientNonce}`)
          : byHeld.get(item.id);
      if (exact) matched.add(exact.nonce);
    }
  }
  while (userKeys.size > RECENT_KEYS) {
    const first = userKeys.values().next().value;
    if (!first) break;
    userKeys.delete(first);
  }
  if (matched.size || provisional.size) {
    update(ref, (entries) =>
      entries.flatMap((entry) => {
        if (matched.has(entry.nonce)) return [];
        const provisionalEcho = provisional.get(entry.nonce);
        return [provisionalEcho ? { ...entry, provisionalEcho } : entry];
      }),
    );
  }
}
