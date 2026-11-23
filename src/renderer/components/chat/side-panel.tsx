import { RefreshCw } from "lucide-react";
import { memo, useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { profileOf } from "../../../shared/agent-profiles/profiles";
import { createLogger } from "../../../shared/log/renderer";
import { locationLabel } from "../../../shared/types/workspace";
import type { ChatController } from "../../services/chat/claude/controller";
import { firstVersionOf } from "../../services/chat/claude/versions";
import { goalViewOf } from "../../services/chat/goal";
import { isUnder } from "../../services/chat/links";
import type { AgentRow } from "../../services/chat/panel";
import { usePlanUsageStore } from "../../services/chat/plan-usage";
import { type ChatTabState, takeReveal } from "../../services/chat/store";
import { chatPanelOf } from "../../services/remote/chat-panel";
import { useAgentProfilesStore } from "../../state/stores/agent-profiles";
import { useGitStore } from "../../state/stores/git";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { profileName } from "../agent-profiles/profile-badge";
import { IconButton } from "../ui/icon-button";
import { Switch } from "../ui/switch";
import { showToast } from "../ui/toast";
import { ConversationChildren } from "./conversation-tree";
import { Row, Section } from "./panel-section";
import {
  type RemotePanelAsk,
  type RemotePanelPart,
  SessionSidePanel,
  TextButton,
} from "./session-side-panel";

export { shownPath as shortPath } from "../../../shared/fs/relative-path";

const log = createLogger("chat-side-panel");

const PANEL_PARTS: ReadonlySet<string> = new Set<RemotePanelPart>([
  "status",
  "context",
  "usage",
  "jobs",
  "changes",
  "mcp",
]);

interface SidePanelProps {
  conversationTabId?: string;
  controller: ChatController;
  state: ChatTabState;
  workspaceId: string;
  cwd: string;
  rootPath: string;
  agents: readonly AgentRow[];
  onStopRun: (agentId: string) => void;
  onShowAgent: (toolUseId: string) => void;
  onShowCall?: (toolUseId: string) => void;
  onBackground?: (toolUseId: string) => void;
  onForkSession: () => void;
  className?: string;
}

export const SidePanel = memo(function SidePanel({
  conversationTabId,
  controller,
  state,
  workspaceId,
  cwd,
  rootPath,
  agents,
  onStopRun,
  onShowAgent,
  onShowCall,
  onBackground,
  onForkSession,
  className,
}: SidePanelProps) {
  const { t } = useTranslation();
  const { model } = state;
  const plan = usePlanUsageStore((s) => s.byKey[controller.usageKey()]?.claude);
  const panel = useMemo(
    () => chatPanelOf({ agent: "claude", title: "", chat: state, plan: { claude: plan } }),
    [state, plan],
  );
  const location = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.location,
  );
  const profileConfig = useAgentProfilesStore((s) => s.config);
  const profile = profileOf(profileConfig, "claude", controller.profileId);
  const branch = useGitStore((s) => {
    const session = s.sessions.get(workspaceId);
    return session?.branchInfo?.current ?? session?.status?.branch?.current ?? null;
  });
  const ready = state.phase === "ready" && model.process === "running";
  const stopFailed = t("chat.panel.stop_failed");
  const onStopTask = useCallback(
    (taskId: string) =>
      controller.stopTask(taskId).catch((err: Error) => {
        log.warn(`Background task stop failed: ${err.message}`);
        showToast({ kind: "error", message: stopFailed });
      }),
    [controller, stopFailed],
  );
  const onRevealed = useCallback((seq: number) => takeReveal(controller.key, seq), [controller]);
  const reveal =
    state.reveal && PANEL_PARTS.has(state.reveal.part) ? (state.reveal as RemotePanelAsk) : null;
  const goal = goalViewOf(model);
  return (
    <SessionSidePanel
      scope={{
        agent: "claude",
        foldKey: controller.key,
        workspaceId,
        cwd,
        rootPath,
        computer: (location && locationLabel(location)) ?? t("chat.panel.env.local_computer"),
        profile: profileName(profile, t),
      }}
      panel={panel}
      model={model}
      history={state.history}
      agents={agents}
      controls
      goal={
        goal
          ? {
              goal,
              running: model.running,
              ...(model.turn?.startedAt !== undefined ? { startedAt: model.turn.startedAt } : {}),
            }
          : null
      }
      reveal={reveal}
      onRevealed={onRevealed}
      branch={isUnder(cwd, rootPath) ? branch : null}
      needsVersion={{
        ...(controller.supports("get_context_usage")
          ? {}
          : { context: firstVersionOf("get_context_usage") }),
        ...(controller.supports("get_usage") ? {} : { usage: firstVersionOf("get_usage") }),
        ...(controller.supports("stop_task") ? {} : { stop: firstVersionOf("stop_task") }),
      }}
      onSectionOpen={(part) => controller.refreshPanel([part])}
      openAgain={ready}
      onShowAgent={onShowAgent}
      onShowCall={onShowCall}
      onCompact={() => controller.send("/compact")}
      onStopTask={onStopTask}
      onStopRun={onStopRun}
      onBackground={onBackground}
      onRemoteControl={
        state.phase === "ready"
          ? async (enabled) => {
              await controller.setRemoteControl(enabled);
            }
          : undefined
      }
      onForkSession={onForkSession}
      mcp={<McpSection controller={controller} state={state} />}
      conversations={
        conversationTabId ? <ConversationChildren tabId={conversationTabId} /> : undefined
      }
      className={className}
      testId="chat-side-panel"
    />
  );
});

function revealSeq(state: ChatTabState, part: RemotePanelPart): number | undefined {
  return state.reveal?.part === part ? state.reveal.seq : undefined;
}

function McpSection({ controller, state }: { controller: ChatController; state: ChatTabState }) {
  const { t } = useTranslation();
  const servers = state.model.mcp;
  const signIn = state.mcpSignIn;
  const ready = state.phase === "ready" && state.model.process === "running";
  const fail = (err: Error) => showToast({ kind: "error", message: err.message });
  useEffect(() => {
    if (ready) controller.refreshPanel(["mcp"]);
  }, [ready, controller]);
  return (
    <Section
      title={t("chat.panel.mcp.title")}
      count={servers?.length}
      empty={servers?.length === 0}
      folded
      onOpen={() => controller.refreshPanel(["mcp"])}
      openAgain={ready}
      reveal={revealSeq(state, "mcp")}
      onRevealed={(seq) => takeReveal(controller.key, seq)}
    >
      {!servers || servers.length === 0 ? (
        <div className="text-app-micro text-muted-foreground">{t("chat.panel.mcp.none")}</div>
      ) : (
        servers.map((server) => {
          const signingIn = signIn?.serverName === server.name;
          return (
            <Row
              key={server.name}
              title={signingIn ? t("chat.panel.mcp.signing_in_hint") : server.name}
            >
              {signingIn ? (
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="break-all">{server.name}</span>
                  <div className="flex flex-wrap items-center gap-1 text-app-micro text-muted-foreground">
                    <span>{t("chat.panel.mcp.signing_in")}</span>
                    <TextButton onClick={() => controller.reopenMcpSignIn()}>
                      {t("chat.panel.mcp.reopen")}
                    </TextButton>
                    <TextButton onClick={() => controller.cancelMcpSignIn()}>
                      {t("chat.panel.mcp.cancel")}
                    </TextButton>
                  </div>
                </div>
              ) : (
                <span className="min-w-0 flex-1 truncate">{server.name}</span>
              )}
              {signingIn ? null : server.status === "needs-auth" ? (
                <TextButton onClick={() => controller.mcpAuthenticate(server.name).catch(fail)}>
                  {t("chat.panel.mcp.sign_in")}
                </TextButton>
              ) : (
                <span className="shrink-0 text-app-micro text-muted-foreground">
                  {t(`chat.panel.mcp.status.${server.status}`, { defaultValue: server.status })}
                </span>
              )}
              {server.status !== "disabled" && !signingIn && (
                <IconButton
                  label={t("chat.panel.mcp.reconnect")}
                  onClick={() => controller.mcpReconnect(server.name).catch(fail)}
                >
                  <RefreshCw className="size-3" />
                </IconButton>
              )}
              <Switch
                checked={server.status !== "disabled"}
                onCheckedChange={(enabled) =>
                  controller.mcpToggle(server.name, enabled).catch(fail)
                }
                aria-label={t("chat.panel.mcp.enabled", { name: server.name })}
              />
            </Row>
          );
        })
      )}
    </Section>
  );
}
