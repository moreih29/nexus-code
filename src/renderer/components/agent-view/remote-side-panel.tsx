import { RefreshCw } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ChatPanel } from "../../../../packages/remote-protocol/src/view";
import type { AgentRow } from "../../services/chat/panel";
import { usePeerMcp } from "../../services/remote/peer-mcp";
import { peerWorkspaceId } from "../../services/remote/peer-workspace";
import type { RemoteTarget } from "../../state/stores/remote-view";
import { Row, Section } from "../chat/panel-section";
import {
  type RemotePanelPart,
  type SessionPanelProps,
  SessionSidePanel,
  TextButton,
} from "../chat/session-side-panel";
import { IconButton } from "../ui/icon-button";
import { Switch } from "../ui/switch";
import { showToast } from "../ui/toast";
import { peerProfileName } from "./remote-profile-chip";

export {
  type RemotePanelAsk,
  type RemotePanelPart,
  remoteAgentsOf,
  SessionSidePanel,
} from "../chat/session-side-panel";

export function remotePanelPartOf(text: string): RemotePanelPart | null {
  const match = /^\/(status|context|usage|mcp)$/i.exec(text.trim());
  return (match?.[1]?.toLowerCase() as RemotePanelPart | undefined) ?? null;
}

export function panelSummaryCounts(panel: ChatPanel | undefined, agents: readonly AgentRow[]) {
  const todos = panel?.todos ?? [];
  const context = panel?.context;
  return {
    jobs: (panel?.tasks ?? []).filter((job) => job.status === "running").length,
    agents: agents.filter((agent) => agent.status === "running").length,
    todos: todos.length
      ? { done: todos.filter((todo) => todo.status === "completed").length, total: todos.length }
      : null,
    contextPercent: context
      ? Math.min(100, Math.round((context.usedTokens / context.maxTokens) * 100))
      : null,
  };
}

export function RemoteSidePanel({
  target,
  ...props
}: Omit<SessionPanelProps, "scope" | "mcp" | "onRefreshAccount" | "contextUsed" | "branch"> & {
  target: RemoteTarget;
  onRefreshMcp?: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { panel, controls, reveal, onRefreshMcp, ...rest } = props;
  const codex = target.kind === "codex";
  return (
    <SessionSidePanel
      {...rest}
      panel={panel}
      controls={controls}
      reveal={reveal}
      scope={{
        agent: codex ? "codex" : "claude",
        foldKey: `remote:${target.deviceId}:${target.workspaceId}:${target.tabId}`,
        computer: target.deviceName,
        cwd: target.cwd ?? target.path,
        rootPath: target.path,
        workspaceId: peerWorkspaceId(target.deviceId, target.workspaceId),
        profile: target.profile ? peerProfileName(target.profile, t) : undefined,
      }}
      mcp={
        codex ? (
          <CodexPanelMcp
            servers={panel?.mcp}
            onRefresh={onRefreshMcp}
            reveal={reveal?.part === "mcp" ? reveal.seq : undefined}
          />
        ) : panel?.mcp ? (
          <RemoteMcp
            target={target}
            servers={panel.mcp}
            controls={controls && panel.can?.mcp === true}
            reveal={reveal?.part === "mcp" ? reveal.seq : undefined}
          />
        ) : undefined
      }
      testId="remote-side-panel"
    />
  );
}

export function CodexPanelMcp({
  servers,
  onRefresh,
  onReload,
  onSignIn,
  signInNames,
  signingIn,
  refreshKey,
  reveal,
}: {
  servers?: ChatPanel["mcp"];
  onRefresh?: () => Promise<void>;
  onReload?: () => Promise<void>;
  onSignIn?: (name: string) => Promise<void>;
  signInNames?: readonly string[];
  signingIn?: string;
  refreshKey?: number;
  reveal?: number;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const run = (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    void action()
      .catch((error: Error) => showToast({ kind: "error", message: error.message }))
      .finally(() => {
        pending.current = false;
        setBusy(false);
      });
  };
  return (
    <Section
      title={t("chat.panel.mcp.title")}
      count={servers?.length}
      folded
      reveal={reveal}
      onOpen={onRefresh ? () => run(onRefresh) : undefined}
      openAgain={refreshKey ?? Boolean(onRefresh)}
    >
      {(onRefresh || onReload) && (
        <Row>
          {onRefresh && (
            <IconButton
              label={t("chat.panel.mcp.refresh")}
              disabled={busy}
              onClick={() => run(onRefresh)}
            >
              <RefreshCw className="size-3" />
            </IconButton>
          )}
          {onReload && (
            <TextButton onClick={() => run(onReload)} disabled={busy}>
              {t("chat.panel.mcp.reload")}
            </TextButton>
          )}
        </Row>
      )}
      {!servers?.length && (
        <div className="text-app-micro text-muted-foreground" role="status">
          {busy
            ? t("chat.panel.mcp.refreshing")
            : t(servers ? "chat.panel.mcp.none" : "chat.panel.mcp.unread")}
        </div>
      )}
      {servers?.map((server) => (
        <Row key={server.name} title={server.name}>
          <span className="min-w-0 flex-1 truncate">{server.name}</span>
          <span className="shrink-0 text-app-micro whitespace-nowrap text-muted-foreground">
            {signingIn === server.name
              ? t("chat.panel.mcp.signing_in")
              : t(`chat.panel.mcp.status.${server.status}`, { defaultValue: server.status })}
          </span>
          {onSignIn &&
            signInNames?.includes(server.name) &&
            server.status === "needs-auth" &&
            !signingIn && (
              <TextButton onClick={() => run(() => onSignIn(server.name))} disabled={busy}>
                {t("chat.panel.mcp.sign_in")}
              </TextButton>
            )}
        </Row>
      ))}
    </Section>
  );
}

function RemoteMcp({
  target,
  servers,
  controls,
  reveal,
}: {
  target: RemoteTarget;
  servers: NonNullable<ChatPanel["mcp"]>;
  controls: boolean;
  reveal?: number;
}) {
  const { t } = useTranslation();
  const mcp = usePeerMcp(target);
  const fail = (err: Error) => showToast({ kind: "error", message: err.message });
  return (
    <Section
      title={t("chat.panel.mcp.title")}
      count={servers.length}
      empty={servers.length === 0}
      folded
      reveal={reveal}
    >
      {servers.length === 0 ? (
        <div className="text-app-micro text-muted-foreground">{t("chat.panel.mcp.none")}</div>
      ) : (
        servers.map((server) => {
          const signingIn = mcp.signIn?.server === server.name;
          return (
            <Row
              key={server.name}
              title={signingIn ? t("chat.panel.mcp.signing_in_hint") : server.name}
            >
              <span className="min-w-0 flex-1 truncate">{server.name}</span>
              {signingIn ? (
                <span className="flex shrink-0 items-center gap-1 text-app-micro whitespace-nowrap text-muted-foreground">
                  {t("chat.panel.mcp.signing_in")}
                  <TextButton onClick={mcp.reopen}>{t("chat.panel.mcp.reopen")}</TextButton>
                  <TextButton onClick={mcp.cancel}>{t("chat.panel.mcp.cancel")}</TextButton>
                </span>
              ) : controls && server.status === "needs-auth" ? (
                <TextButton onClick={() => mcp.authenticate(server.name).catch(fail)}>
                  {t("chat.panel.mcp.sign_in")}
                </TextButton>
              ) : (
                <span className="shrink-0 text-app-micro whitespace-nowrap text-muted-foreground">
                  {t(`chat.panel.mcp.status.${server.status}`, { defaultValue: server.status })}
                </span>
              )}
              {controls && server.status !== "disabled" && !signingIn && (
                <IconButton
                  label={t("chat.panel.mcp.reconnect")}
                  onClick={() => mcp.reconnect(server.name).catch(fail)}
                >
                  <RefreshCw className="size-3" />
                </IconButton>
              )}
              {controls && (
                <Switch
                  checked={server.status !== "disabled"}
                  onCheckedChange={(enabled) => mcp.toggle(server.name, enabled).catch(fail)}
                  aria-label={t("chat.panel.mcp.enabled", { name: server.name })}
                />
              )}
            </Row>
          );
        })
      )}
    </Section>
  );
}
