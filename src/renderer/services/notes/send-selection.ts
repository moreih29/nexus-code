import type { ChatAgent } from "../../../shared/sessions/task-agent";
import { chatPropsWithProfile } from "../../state/operations/tabs";
import { agentTabController } from "../chat/agent-tab";
import { revealTabById } from "../chat/open-beside";
import { sendFirstMessage } from "../chat/transport/submission";
import { openTab } from "../cli/placement";
import { chatNoteTarget, recordChatNoteLink } from "./chat-link";
import { selectionPrompt } from "./prompt";
import { sendToConversation } from "./send-to-conversation";

type SelectionDestination =
  | { agent: ChatAgent; workspaceId: string; tabId: string; linkId: string }
  | { agent: ChatAgent; cwd: string };

export async function sendNoteSelection(
  note: { workspaceId: string; noteId: string; title: string },
  excerpt: string,
  destination: SelectionDestination,
): Promise<{ queued: boolean; linked: boolean }> {
  const { workspaceId, noteId } = note;
  const { agent } = destination;
  const prompt = selectionPrompt(note, excerpt);
  let queued = false;
  let target: ReturnType<typeof chatNoteTarget>;
  if ("tabId" in destination) {
    target = chatNoteTarget(destination);
    if (!target) throw new Error("The conversation closed");
    queued = await sendToConversation(target.workspaceId, target.tabId, prompt);
  } else {
    const { cwd } = destination;
    const props = chatPropsWithProfile<{ cwd: string; profileId?: string }>(workspaceId, agent, {
      cwd,
    });
    const tabId = openTab(workspaceId, { type: agent, props }, { background: true });
    const controller = agentTabController(workspaceId, tabId);
    target = chatNoteTarget({ workspaceId, tabId, agent });
    if (!target || !controller) throw new Error("Could not open the conversation");
    revealTabById(workspaceId, tabId);
    await sendFirstMessage(workspaceId, tabId, controller, prompt);
    target = chatNoteTarget(target) ?? target;
  }
  try {
    await recordChatNoteLink(
      workspaceId,
      noteId,
      { ...target, kind: "selection" },
      "linkId" in destination ? destination.linkId : undefined,
    );
    return { queued, linked: true };
  } catch {
    return { queued, linked: false };
  }
}
