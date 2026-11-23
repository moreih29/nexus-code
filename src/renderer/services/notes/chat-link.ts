import type { NewNoteLink, NoteConversation, NoteLinkTarget } from "../../../shared/notes/links";
import { useTabsStore } from "../../state/stores/tabs";
import { notesApi } from "./api";
import { tabLinkTarget } from "./conversation";
import { type NoteReference, withNoteMentions } from "./prompt";

export type ChatNoteTarget = NoteLinkTarget & Pick<NoteConversation, "agent">;

export function chatNoteTarget(chat: NoteConversation): ChatNoteTarget | undefined {
  const tab = useTabsStore.getState().byWorkspace[chat.workspaceId]?.[chat.tabId];
  if (tab?.type === chat.agent)
    return { ...tabLinkTarget(chat.workspaceId, tab), agent: chat.agent };
}

export async function syncChatNoteLink(target: ChatNoteTarget): Promise<void> {
  const current = chatNoteTarget(target);
  if (
    current &&
    (current.session !== target.session ||
      current.title !== target.title ||
      current.profileId !== target.profileId)
  ) {
    await notesApi.updateLinksForTab(current);
  }
}

export async function recordChatNoteLink(
  noteWorkspaceId: string,
  noteId: string,
  link: NewNoteLink,
  touchExisting?: true | string,
): Promise<void> {
  await notesApi.addLink(noteWorkspaceId, noteId, link, touchExisting);
  await syncChatNoteLink(link);
}

export async function sendWithNoteMentions(
  body: string,
  notes: readonly NoteReference[],
  target: ChatNoteTarget | undefined,
  send: (message: string) => Promise<void>,
): Promise<boolean> {
  await send(withNoteMentions(body, notes));
  if (!notes.length) return true;
  if (!target) return false;
  const links = await Promise.allSettled(
    notes.map(({ noteId }) =>
      recordChatNoteLink(target.workspaceId, noteId, { ...target, kind: "mention" }),
    ),
  );
  return links.every(({ status }) => status === "fulfilled");
}
