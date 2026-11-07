// Inbox — the title bar's list of the agent sessions waiting on the user,
// from every workspace: those that need an answer, a permission or a look at
// an error, then those done and not looked at.
//
// The button counts the first kind; the second only lights a dot, since a
// finished turn can wait. Picking a session shows its terminal with the
// keyboard in it. The glyphs and words are the sessions tab's.

import { Inbox } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { COMMANDS } from "../../../shared/keybindings/commands";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { shortcutFor } from "../../keybindings/shortcut-labels";
import type { InboxItem } from "../../services/sessions/inbox";
import type { AgentSession } from "../../services/sessions/model";
import { useNow } from "../../services/sessions/use-family";
import {
  goToNextWaiting,
  goToSession,
  markRead,
  useInbox,
} from "../../services/sessions/use-inbox";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { AgentBadge, durationLabel, StateGlyph, stateLabel } from "../sessions/session-status";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { IconButton } from "../ui/icon-button";

export function InboxButton() {
  const { t } = useTranslation();
  const inbox = useInbox();
  // How long each has waited, ticking only while the list is shown.
  const [open, setOpen] = useState(false);
  const now = useNow(open);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const waiting = inbox.items.filter((item) => item.session.phase === "attention");
  const done = inbox.items.filter((item) => item.session.phase === "done");
  const nextShortcut = shortcutFor(COMMANDS.sessionNextWaiting);
  // Set when a pick goes to a terminal, which then has the keyboard: the
  // menu must not hand it back to this button as it closes.
  const wentToTerminal = useRef(false);
  const go = (session: AgentSession) => {
    wentToTerminal.current = true;
    goToSession(session);
  };

  return (
    <DropdownMenuRoot onOpenChange={setOpen}>
      <DropdownMenuTrigger>
        <IconButton
          label={t("inbox.title")}
          aria-label={t("inbox.aria", { count: inbox.attention })}
          size="md"
          className="app-no-drag relative"
        >
          <Inbox className="size-4" aria-hidden="true" />
          {inbox.attention > 0 ? (
            <span
              aria-hidden="true"
              className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-(--state-warning-fg) px-1 text-app-micro font-semibold leading-none text-background tabular-nums"
            >
              {inbox.attention > 9 ? "9+" : inbox.attention}
            </span>
          ) : inbox.unread > 0 ? (
            <span
              aria-hidden="true"
              className="absolute top-1 right-1 size-1.5 rounded-full bg-(--tab-claude-attention-fg)"
            />
          ) : null}
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={(event) => {
          if (!wentToTerminal.current) return;
          wentToTerminal.current = false;
          event.preventDefault();
        }}
      >
        <div className="w-[340px]">
          {inbox.items.length === 0 && (
            <DropdownMenuItem disabled>{t("inbox.empty")}</DropdownMenuItem>
          )}
          {waiting.length > 0 && <DropdownMenuLabel>{t("inbox.waiting")}</DropdownMenuLabel>}
          {waiting.map((item) => (
            <InboxRow
              key={item.session.key}
              item={item}
              workspaces={workspaces}
              now={now}
              onGo={go}
            />
          ))}
          {done.length > 0 && <DropdownMenuLabel>{t("inbox.done")}</DropdownMenuLabel>}
          {done.map((item) => (
            <InboxRow
              key={item.session.key}
              item={item}
              workspaces={workspaces}
              now={now}
              onGo={go}
            />
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={inbox.items.length === 0}
            onSelect={() => {
              wentToTerminal.current = true;
              void goToNextWaiting();
            }}
          >
            {t("inbox.next")}
            {nextShortcut && <DropdownMenuShortcut>{nextShortcut}</DropdownMenuShortcut>}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={done.length === 0} onSelect={() => markRead(done)}>
            {t("inbox.mark_read")}
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}

/**
 * One session: its state, workspace, agent and how long it has waited, over
 * its last message or, without one, the last prompt it was given.
 */
function InboxRow({
  item,
  workspaces,
  now,
  onGo,
}: {
  item: InboxItem;
  workspaces: readonly WorkspaceMeta[];
  now: number;
  onGo: (session: AgentSession) => void;
}) {
  const { session, workspace } = item;
  const duration = durationLabel(session.since, now);
  const detail = session.message ?? session.prompt;
  return (
    <DropdownMenuItem onSelect={() => onGo(session)}>
      <span className="grid min-w-0 flex-1 grid-cols-[12px_minmax(0,1fr)] items-center gap-x-1.5 gap-y-0.5 py-0.5">
        <StateGlyph state={session.state} />
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0">{stateLabel(session)}</span>
          <span className="truncate text-muted-foreground">
            · {workspaceLabel(workspace, workspaces)}
          </span>
          <AgentBadge agent={session.agent} />
          {duration && (
            <span className="ml-auto shrink-0 pl-2 text-muted-foreground">{duration}</span>
          )}
        </span>
        {detail && <span className="col-start-2 truncate text-muted-foreground">{detail}</span>}
      </span>
    </DropdownMenuItem>
  );
}

/** The workspace's name; a task's after its workspace's, as the title bar shows it. */
function workspaceLabel(workspace: WorkspaceMeta, workspaces: readonly WorkspaceMeta[]): string {
  const parentId = workspace.task?.parentId;
  const parent = parentId ? workspaces.find((w) => w.id === parentId) : undefined;
  return parent ? `${parent.name} / ${workspace.name}` : workspace.name;
}
