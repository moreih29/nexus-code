import { agentTabController } from "../chat/agent-tab";

/** Sends as the user with the same controls as the chat composer. */
export async function sendToConversation(
  workspaceId: string,
  tabId: string,
  text: string,
): Promise<boolean> {
  const target = agentTabController(workspaceId, tabId);
  if (!target) throw new Error("The conversation closed");
  if (target.agent === "codex") {
    return Boolean(await target.controller.sendWithTiming(text, [], "now"));
  }
  await target.controller.prepareSend();
  if (target.controller.state.model.running) {
    return Boolean(target.controller.enqueue(text));
  }
  await target.controller.send(text);
  return false;
}
