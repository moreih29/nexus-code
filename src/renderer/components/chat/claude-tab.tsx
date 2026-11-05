// A Claude tab: one Claude Code session run headless by the workspace's
// agent, shown as a conversation. The program outlives the window and the
// connection, so the view only reads what its controller has.

import { MessageSquareText } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  type ChatController,
  chatController,
  type PermissionAnswer,
} from "../../services/chat/controller";
import type { PermissionRequest } from "../../services/chat/model";
import { type ChatTabState, useChatTab } from "../../services/chat/store";
import { MIN_CLAUDE_VERSION } from "../../services/chat/versions";
import type { ClaudeTabProps } from "../../state/stores/tabs";
import { useTabsStore } from "../../state/stores/tabs";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { Banner, type BannerAction } from "../ui/banner";
import { Composer } from "./composer";
import { MessageList } from "./message-list";
import { PermissionCard } from "./permission-card";
import { StatusLine } from "./status-line";

interface ClaudeTabViewProps {
  workspaceId: string;
  tabId: string;
  props: ClaudeTabProps;
  isVisible: boolean;
}

/** Longest first message kept as the tab's title. */
const TITLE_CHARS = 40;

export function ClaudeTabView({ workspaceId, tabId, props, isVisible }: ClaudeTabViewProps) {
  const { t } = useTranslation();
  const rootPath = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.rootPath ?? "",
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: the target is read once; the controller keeps the session it moves on to
  const controller = useMemo(
    () =>
      chatController(
        {
          workspaceId,
          tabId,
          cwd: props.cwd,
          sessionId: props.sessionId,
          fork: props.fork,
        },
        {
          onSession: (sessionId) =>
            useTabsStore.getState().setClaudeSession(workspaceId, tabId, sessionId),
          onFirstMessage: (text) =>
            useTabsStore.getState().setProcessTitle(workspaceId, tabId, titleOf(text)),
        },
      ),
    [workspaceId, tabId],
  );
  const state = useChatTab(workspaceId, tabId);

  // Opened the first time the tab is shown, so restored tabs in the
  // background start nothing until they are looked at.
  const opened = useRef(false);
  useEffect(() => {
    if (!isVisible || opened.current) return;
    opened.current = true;
    void controller.open();
  }, [isVisible, controller]);

  const onAnswer = (request: PermissionRequest, answer: PermissionAnswer) => {
    void controller.answerPermission(request, answer).catch(() => {});
  };

  return (
    <div className="flex h-full flex-col bg-background" data-testid="claude-tab">
      <PhaseBanner controller={controller} state={state} />
      <MessageList
        workspaceId={workspaceId}
        cwd={props.cwd}
        rootPath={rootPath}
        history={state.history}
        model={state.model}
        empty={
          state.phase === "ready" || state.phase === "ended" ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
              <MessageSquareText className="size-8" />
              <div className="text-app-body">{t("chat.empty.title")}</div>
              <div className="max-w-full truncate font-mono text-app-micro" title={props.cwd}>
                {props.cwd}
              </div>
            </div>
          ) : null
        }
      />
      {/* Docked over the composer, so a request is seen wherever the list is scrolled. */}
      {(state.model.permissions.length > 0 || state.model.running) && (
        <div className="max-h-[60%] shrink-0 overflow-y-auto px-4 pt-2">
          <div className="mx-auto flex max-w-[860px] flex-col gap-2">
            {state.model.permissions.length > 0 && (
              <PermissionCard
                requests={state.model.permissions}
                workspaceId={workspaceId}
                cwd={props.cwd}
                rootPath={rootPath}
                onAnswer={onAnswer}
              />
            )}
            <StatusLine model={state.model} />
          </div>
        </div>
      )}
      <RateLimitBanner state={state} />
      <Composer controller={controller} state={state} />
    </div>
  );
}

function titleOf(text: string): string {
  const line = text.split("\n")[0].trim();
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1)}…` : line;
}

function PhaseBanner({ controller, state }: { controller: ChatController; state: ChatTabState }) {
  const { t } = useTranslation();
  const retry: BannerAction = {
    label: t("chat.phase.retry"),
    onAction: () => void controller.open(),
  };
  const banners: React.ReactNode[] = [];
  switch (state.phase) {
    case "starting":
      banners.push(<Banner key="phase" variant="info" message={t("chat.phase.starting")} />);
      break;
    case "held":
      banners.push(<Banner key="phase" variant="warning" message={t("chat.phase.held")} />);
      break;
    case "ended":
      banners.push(
        <Banner
          key="phase"
          variant="info"
          message={t("chat.phase.ended")}
          details={state.model.exit?.stderrTail || undefined}
          actions={[{ label: t("chat.phase.restart"), onAction: () => void controller.restart() }]}
        />,
      );
      break;
    case "not-found":
      banners.push(
        <Banner
          key="phase"
          variant="error"
          message={t("chat.phase.not_found")}
          details={state.error}
          actions={[retry]}
        />,
      );
      break;
    case "failed":
      banners.push(
        state.error === "old-version" ? (
          <Banner
            key="phase"
            variant="error"
            message={t("chat.phase.old_version", {
              version: state.version ?? "?",
              min: MIN_CLAUDE_VERSION,
            })}
            actions={[retry]}
          />
        ) : (
          <Banner
            key="phase"
            variant="error"
            message={t("chat.phase.failed")}
            details={state.error}
            actions={[retry]}
          />
        ),
      );
      break;
  }
  if (state.truncated) {
    banners.push(<Banner key="truncated" variant="info" message={t("chat.phase.truncated")} />);
  }
  if (banners.length === 0) return null;
  return <div className="shrink-0 pt-1">{banners}</div>;
}

function RateLimitBanner({ state }: { state: ChatTabState }) {
  const { t } = useTranslation();
  const limit = state.model.rateLimit;
  if (!limit || limit.status === "allowed") return null;
  const resets = limit.resetsAt
    ? new Date(limit.resetsAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;
  const rejected = limit.status === "rejected";
  const message = rejected
    ? resets
      ? t("chat.rate_limit.rejected_until", { time: resets })
      : t("chat.rate_limit.rejected")
    : resets
      ? t("chat.rate_limit.warning_until", { time: resets })
      : t("chat.rate_limit.warning");
  return (
    <div className="shrink-0">
      <Banner variant={rejected ? "error" : "warning"} message={message} />
    </div>
  );
}
