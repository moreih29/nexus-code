// Which program a chat tab talks to, for the words the shared views use:
// "Claude exited" in a Claude tab, "Codex exited" in a Codex tab. A string
// with a `_codex` variant takes it as i18next's context; the rest are the same.

import { createContext, useContext } from "react";

export type ChatAgent = "claude" | "codex";

export const ChatAgentContext = createContext<ChatAgent>("claude");

/** The i18next context of the tab's program: none for Claude, whose strings are the plain ones. */
export function useAgentContext(): { context?: string } {
  const agent = useContext(ChatAgentContext);
  return agent === "claude" ? {} : { context: agent };
}
