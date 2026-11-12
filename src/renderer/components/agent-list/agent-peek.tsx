// Agent list — an agent's card, beside the list: an agent a conversation
// runs has no tab of its own, so picking its row opens this instead, with
// what it was asked, did and wrote, its permission requests to answer, and
// the way to its conversation's tab. Escape or a press outside closes it.

import { Popover as RadixPopover } from "radix-ui";
import { useMemo, useRef } from "react";
import { cn } from "@/utils/cn";
import type { AgentRun, PermissionAsk } from "../../../shared/claude/activity";
import type { AgentSession, WorktreeEntry } from "../../services/agent-sessions/model";
import { POPOVER_CLASS } from "../ui/popover";
import { AgentDetail } from "./agent-detail";
import { agentTitle } from "./agent-status";

export function AgentPeek({
  anchor,
  worktree,
  session,
  agent,
  asks,
  onShowSession,
  onClose,
}: {
  /** The agent's row, which the card stands beside. */
  anchor: HTMLElement;
  worktree: WorktreeEntry;
  session: AgentSession;
  agent: AgentRun;
  /** The permission requests the agent waits on. */
  asks: readonly PermissionAsk[];
  onShowSession: () => void;
  onClose: () => void;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  // Where the row was last seen, for while the list draws it again.
  const lastRect = useRef<DOMRect | null>(null);
  const measured = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () => {
          if (anchor.isConnected) lastRect.current = anchor.getBoundingClientRect();
          return lastRect.current ?? anchor.getBoundingClientRect();
        },
      },
    }),
    [anchor],
  );
  return (
    <RadixPopover.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <RadixPopover.Anchor virtualRef={measured} />
      <RadixPopover.Portal>
        <RadixPopover.Content
          ref={contentRef}
          role="dialog"
          aria-label={agentTitle(agent)}
          side="right"
          align="start"
          sideOffset={8}
          collisionPadding={8}
          tabIndex={-1}
          // The card takes the keyboard, for Escape; the list keeps it once it closes.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            contentRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => event.preventDefault()}
          data-testid="agent-list-agent-card"
          className={cn(POPOVER_CLASS, "w-[400px] max-w-[calc(100vw-16px)] p-0")}
        >
          <AgentDetail
            worktree={worktree}
            session={session}
            agent={agent}
            asks={asks}
            visible
            onShowSession={onShowSession}
            onClose={onClose}
          />
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
