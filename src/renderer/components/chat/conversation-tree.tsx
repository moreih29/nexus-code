import { CornerDownRight, GitBranch } from "lucide-react";
import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TerminalOpener } from "../../../shared/chat/relay";
import { revealInWorkspace } from "../../services/agent-sessions/actions";
import {
  MAX_SESSION_INDENT,
  type SessionTreeNode,
  sessionTree,
} from "../../services/agent-sessions/session-tree";
import { useSessionParent } from "../../services/agent-sessions/use-session-parent";
import { useAgents } from "../../services/agent-view/use-agents";
import { useAgentViewStore } from "../../state/stores/agent-view";
import { cn } from "../../utils/cn";
import { StateGlyph, stateColor, stateLabel, useDurationLabel } from "../agent-list/session-status";
import { useParentCaption } from "../agent-list/session-tree-rows";
import { AgentMark } from "../agent-list/status-view";
import { Button } from "../ui/button";
import { Section } from "./panel-section";

export function ConversationParentChip({ opener }: { opener?: TerminalOpener }) {
  const workspaceView = useAgentViewStore((s) => s.mode === "workspace");
  return workspaceView && opener ? <ParentChip opener={opener} /> : null;
}

function ParentChip({ opener }: { opener: TerminalOpener }) {
  const { name, open } = useSessionParent(opener);
  const closed = !opener.device && !open;
  const parent = useParentCaption(name, opener.device, closed);
  if (!parent) return null;
  const className =
    "max-w-full truncate rounded-full border border-border px-2 py-0.5 text-app-micro text-muted-foreground";
  return (
    <div className="flex shrink-0 px-3 py-1">
      {open ? (
        <Button
          type="button"
          variant="outline"
          className={cn(className, "h-auto font-normal")}
          title={parent.hint}
          data-testid="conversation-parent"
          onClick={() => revealInWorkspace(open)}
        >
          <span className="min-w-0 truncate">{parent.label}</span>
        </Button>
      ) : (
        <span
          className={cn(className, closed && "opacity-60")}
          title={parent.hint}
          data-testid="conversation-parent"
        >
          {parent.label}
        </span>
      )}
    </div>
  );
}

export const ConversationChildren = memo(function ConversationChildren({
  tabId,
}: {
  tabId: string;
}) {
  const workspaceView = useAgentViewStore((s) => s.mode === "workspace");
  return workspaceView ? <ChildrenSection tabId={tabId} /> : null;
});

function findNode(roots: readonly SessionTreeNode[], tabId: string): SessionTreeNode | undefined {
  for (const node of roots) {
    if (node.session.tabId === tabId) return node;
    const found = findNode(node.children, tabId);
    if (found) return found;
  }
  return undefined;
}

function ChildrenSection({ tabId }: { tabId: string }) {
  const { t } = useTranslation();
  const { byKey } = useAgents();
  const parent = useMemo(() => {
    const tree = sessionTree([...byKey.values()].map(({ session }) => session));
    return findNode(tree, tabId);
  }, [byKey, tabId]);
  if (!parent?.count) return null;
  const workspaceLabel = (key: string) => {
    const workspace = byKey.get(key)?.workspace;
    return workspace?.task?.branch ?? workspace?.name;
  };
  return (
    <Section key={tabId} title={t("chat.panel.conversations_it_made")} count={parent.count}>
      {parent.children.map((node) => (
        <ChildConversation
          key={node.session.key}
          node={node}
          level={0}
          parentWorkspaceId={parent.session.workspaceId}
          workspaceLabel={workspaceLabel}
        />
      ))}
    </Section>
  );
}

function ChildConversation({
  node,
  level,
  parentWorkspaceId,
  workspaceLabel,
}: {
  node: SessionTreeNode;
  level: number;
  parentWorkspaceId: string;
  workspaceLabel: (sessionKey: string) => string | undefined;
}) {
  const { session } = node;
  const time = useDurationLabel(session.since ?? session.openedAt);
  const state = stateLabel(session);
  const branch =
    session.workspaceId === parentWorkspaceId ? undefined : workspaceLabel(session.key);
  const parent = useParentCaption(
    level >= MAX_SESSION_INDENT ? node.parentName : undefined,
    undefined,
    false,
  );
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        data-testid="conversation-child"
        className="h-auto w-full min-w-0 justify-start gap-1.5 px-1 py-1 text-left text-app-ui-sm font-normal"
        style={{ paddingInlineStart: `${4 + Math.min(level, MAX_SESSION_INDENT - 1) * 12}px` }}
        onClick={() => revealInWorkspace(session)}
        title={[session.title, state, time].filter(Boolean).join(" · ")}
      >
        {level > 0 && (
          <CornerDownRight aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span role="img" aria-label={state} className="inline-flex shrink-0">
          <StateGlyph state={session.state} />
        </span>
        <AgentMark session={session} />
        <span className="min-w-0 flex-1 truncate">{session.title}</span>
        {parent && (
          <span
            className="max-w-[35%] truncate text-app-micro text-muted-foreground"
            title={parent.hint}
          >
            {parent.label}
          </span>
        )}
        {branch && (
          <span
            className="flex max-w-[35%] min-w-0 items-center gap-0.5 text-app-micro text-muted-foreground"
            title={branch}
          >
            <GitBranch aria-hidden className="size-3 shrink-0" />
            <span className="truncate">{branch}</span>
          </span>
        )}
        {time && (
          <span
            className={cn(
              "shrink-0 text-app-micro tabular-nums",
              session.phase === "idle" ? "text-muted-foreground" : stateColor(session.state),
            )}
          >
            {time}
          </span>
        )}
      </Button>
      {node.children.map((child) => (
        <ChildConversation
          key={child.session.key}
          node={child}
          level={level + 1}
          parentWorkspaceId={parentWorkspaceId}
          workspaceLabel={workspaceLabel}
        />
      ))}
    </>
  );
}
