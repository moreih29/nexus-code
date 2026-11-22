import { SquareTerminal } from "lucide-react";
import { Tabs } from "radix-ui";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type PeerSessionTab,
  type PeerWorkspaceTarget,
  peerTabId,
} from "../../state/stores/peer-workspace";
import { cn } from "../../utils/cn";
import { RemoteSessionPane } from "../agent-view/remote-pane";
import type { RemoteSessionHost } from "../agent-view/remote-session-host";
import { ClaudeIcon, CodexIcon } from "../chat/agent-icons";
import { EmptyState } from "../ui/empty-state";
import {
  hidePeerWorkspaceSession,
  markPeerWorkspaceSessionGone,
  openPeerWorkspaceFileBeside,
  peerSessionFocusKey,
  showPeerWorkspaceSession,
} from "./session-placement";

export const peerSessionIcons = { claude: ClaudeIcon, codex: CodexIcon, terminal: SquareTerminal };

export function PeerSessionTabBody({
  workspace,
  tab,
  selected,
  shown,
}: {
  workspace: PeerWorkspaceTarget;
  tab: PeerSessionTab;
  selected: boolean;
  shown: boolean;
}) {
  const { t } = useTranslation();
  const { target, gone } = tab;
  const visible = shown && selected;
  const [visited, setVisited] = useState(visible);
  if (visible && !visited) setVisited(true);
  const host = useMemo<RemoteSessionHost>(
    () => ({
      focusKey: peerSessionFocusKey(workspace, target.tabId),
      openSession: (session) => showPeerWorkspaceSession(workspace, session),
      hideSession: () => hidePeerWorkspaceSession(workspace, target),
      onGone: () => markPeerWorkspaceSessionGone(workspace, target),
      openFileBeside: (path, { at }) =>
        openPeerWorkspaceFileBeside(
          workspace,
          path,
          at?.line ? { line: at.line, column: at.column } : undefined,
        ),
    }),
    [workspace, target],
  );
  return (
    <Tabs.Content
      forceMount
      value={encodeURIComponent(peerTabId(tab))}
      className={cn("relative min-h-0 flex-1", !selected && "hidden")}
    >
      {gone ? (
        <EmptyState title={t("peerWorkspace.sessionGone")} tone="status" className="h-full" />
      ) : (
        (visible || visited) && <RemoteSessionPane target={target} host={host} visible={visible} />
      )}
    </Tabs.Content>
  );
}
