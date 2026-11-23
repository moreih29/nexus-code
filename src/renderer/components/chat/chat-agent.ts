import { createContext, useContext } from "react";

export type ChatAgent = "claude" | "codex";

export const ChatAgentContext = createContext<ChatAgent>("claude");

export function useAgentContext(): { context?: string } {
  const agent = useContext(ChatAgentContext);
  return agent === "claude" ? {} : { context: agent };
}
