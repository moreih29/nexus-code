import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AgentRun } from "../../../shared/claude/activity";
import { useNow } from "../../hooks/use-now";
import type { ChatItem, ChatModel } from "../../services/chat/model";
import { useRunConversation } from "../../services/chat/print-run-transcript";
import { stopPrintRun } from "../../services/chat/print-runs";
import { openClaudeTab, openCodexTab } from "../../state/operations/tabs";
import { AgentFlow } from "../agent-list/agent-flow";
import { BannerDismissButton } from "../ui/banner";
import { ChatMarkdown } from "./chat-markdown";
import { MessageList, type OlderMessages } from "./message-list";
import { RunHeader, RunOpenButton, RunStopButton } from "./run-header";

export interface RunConversation {
  model: ChatModel;
  items?: ChatItem[];
  truncated?: boolean;
  older?: OlderMessages;
}

export function PrintRunPane({
  workspaceId,
  tabId,
  cwd,
  rootPath,
  run,
  visible,
  stopRun,
  openInTab: openThere,
  conversation: given,
}: {
  workspaceId: string;
  tabId: string;
  cwd: string;
  rootPath: string;
  run: AgentRun;
  visible: boolean;
  stopRun?: (() => Promise<boolean>) | null;
  openInTab?: ((sessionId: string) => void) | null;
  conversation?: RunConversation | null;
}) {
  const { t } = useTranslation();
  const running = run.end === undefined;
  const own = useRunConversation(workspaceId, tabId, run, visible && given === undefined);
  const conversation: RunConversation | null = given === undefined ? own : given;
  const [stopFailed, setStopFailed] = useState(false);
  const stopper = stopRun === undefined ? () => stopPrintRun(workspaceId, tabId, run.id) : stopRun;
  const stop = stopper
    ? () => {
        setStopFailed(false);
        void stopper().then((stopped) => setStopFailed(!stopped));
      }
    : null;
  const { sessionId } = run;
  const codex = run.program === "codex";
  const openInTab =
    openThere === undefined
      ? (id: string) =>
          codex
            ? openCodexTab(workspaceId, { cwd, threadId: id })
            : openClaudeTab(workspaceId, { cwd, sessionId: id })
      : openThere;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="chat-print-run">
      <RunHeader
        run={run}
        className="px-4 pt-4 pb-2"
        actions={
          running
            ? stop && <RunStopButton onClick={stop} />
            : sessionId !== undefined &&
              openInTab && (
                <RunOpenButton
                  label={t("chat.run.open_in_tab")}
                  onClick={() => openInTab(sessionId)}
                />
              )
        }
      />
      {stopFailed && (
        <div className="flex shrink-0 items-center gap-2 px-4 pb-2 text-app-ui-sm text-muted-foreground">
          <span className="flex-1">{t("chat.run.stop_failed")}</span>
          <BannerDismissButton
            dismiss={{ label: t("action.dismiss"), onDismiss: () => setStopFailed(false) }}
          />
        </div>
      )}
      <RunBody
        workspaceId={workspaceId}
        cwd={cwd}
        rootPath={rootPath}
        run={run}
        visible={visible}
        conversation={conversation}
      />
    </div>
  );
}

export function RunBody({
  workspaceId,
  cwd,
  rootPath,
  run,
  visible,
  conversation,
  summary = false,
}: {
  workspaceId: string;
  cwd: string;
  rootPath: string;
  run: AgentRun;
  visible: boolean;
  conversation: RunConversation | null;
  summary?: boolean;
}) {
  const running = run.end === undefined;
  const now = useNow(visible && running);
  const renderText = (text: string) => (
    <ChatMarkdown text={text} workspaceId={workspaceId} cwd={cwd} rootPath={rootPath} />
  );
  if (!conversation) {
    return (
      <div
        className="app-scrollbar flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pt-2 pb-4"
        data-testid="chat-print-run-summary"
      >
        <AgentFlow agent={run} now={now} renderText={renderText} />
      </div>
    );
  }
  return (
    <>
      {summary && running && (
        <div className="shrink-0 border-b border-border px-4 pb-2" data-testid="run-brief">
          <AgentFlow agent={run} now={now} renderText={renderText} brief />
        </div>
      )}
      <MessageList
        workspaceId={workspaceId}
        cwd={cwd}
        rootPath={rootPath}
        history={null}
        model={conversation.model}
        items={conversation.items}
        itemsDone={conversation.items ? !running : undefined}
        historyTruncated={conversation.truncated}
        older={conversation.older}
      />
    </>
  );
}
