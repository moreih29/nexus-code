/**
 * Agent panel: what a new task opens with, the chat tabs' text, and the
 * nexus command that agents in the app's terminals use to drive NexusCode —
 * a master switch, what nexus may do to other workspaces, and whether Claude
 * Code sessions are told about it when they start.
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_TASK_AGENT } from "../../../../shared/sessions/task-agent";
import { DEFAULT_SESSIONS_VIEW, SESSIONS_VIEWS } from "../../../../shared/sessions/view";
import { ipcCallResult } from "../../../ipc/client";
import {
  CHAT_FONT_SIZE,
  CHAT_FONT_SIZE_MAX,
  CHAT_FONT_SIZE_MIN,
} from "../../../services/chat/chat-font";
import { type CrossWorkspacePolicy, useAgentCliStore } from "../../../state/stores/agent-cli";
import { useChatFontStore, useChatFontStyle } from "../../../state/stores/chat-font";
import { useSessionsViewStore } from "../../../state/stores/sessions-view";
import { useTerminalStore } from "../../../state/stores/terminal";
import { NumberInput } from "../../ui/number-input";
import { taskAgentOptions } from "../../workspace/task-agent-options";
import { FontFamilyRow } from "../font-family-row";
import { SettingsGroup, SettingsPage, SettingsRow, SettingsSwitch } from "../section";
import { SegmentedControl } from "../segmented-control";

export function AgentPanel() {
  const { t } = useTranslation("settings");
  const taskAgent = useTerminalStore((s) => s.taskAgent);
  const setTaskAgent = useTerminalStore((s) => s.setTaskAgent);
  const sessionsView = useSessionsViewStore((s) => s.defaultView);
  const setSessionsView = useSessionsViewStore((s) => s.setDefault);
  const enabled = useAgentCliStore((s) => s.enabled);
  const crossWorkspace = useAgentCliStore((s) => s.crossWorkspace);
  const agentContext = useAgentCliStore((s) => s.agentContext);
  const setLocal = useAgentCliStore((s) => s.set);

  const policyLabel = t("agentCli.crossWorkspace.label");
  const policies: { value: CrossWorkspacePolicy; label: string }[] = [
    { value: "ask", label: t("agentCli.crossWorkspace.ask") },
    { value: "allow", label: t("agentCli.crossWorkspace.allow") },
    { value: "deny", label: t("agentCli.crossWorkspace.deny") },
  ];

  return (
    <SettingsPage>
      <SettingsGroup title={t("agent.newTask")}>
        {/* What the agents tab's [+] and a new task open; New Task can pick another per task. */}
        <SettingsRow
          label={t("terminal.taskAgent.label")}
          description={t("terminal.taskAgent.hint")}
          dirty={taskAgent !== undefined}
          onReset={() => setTaskAgent(undefined)}
        >
          <SegmentedControl
            options={taskAgentOptions()}
            value={taskAgent ?? DEFAULT_TASK_AGENT}
            onChange={setTaskAgent}
            label={t("terminal.taskAgent.label")}
          />
        </SettingsRow>

        {/* The view an agents tab opens in, until switched there. */}
        <SettingsRow
          label={t("terminal.sessionsView.label")}
          description={t("terminal.sessionsView.hint")}
          dirty={sessionsView !== undefined}
          onReset={() => setSessionsView(undefined)}
        >
          <SegmentedControl
            options={SESSIONS_VIEWS.map((value) => ({
              value,
              label: t(`common:sessions.view.${value}`),
            }))}
            value={sessionsView ?? DEFAULT_SESSIONS_VIEW}
            onChange={setSessionsView}
            label={t("terminal.sessionsView.label")}
          />
        </SettingsRow>
      </SettingsGroup>

      <ChatFontGroup />

      <SettingsGroup title={t("agentCli.heading")}>
        <SettingsSwitch
          label={t("agentCli.enabled.label")}
          description={t("agentCli.enabled.description")}
          checked={enabled}
          onChange={(next) => {
            setLocal({ enabled: next });
            void ipcCallResult("appState", "set", { cliEnabled: next });
          }}
        />
        <SettingsRow label={policyLabel} description={t("agentCli.crossWorkspace.description")}>
          <SegmentedControl
            options={policies}
            value={crossWorkspace}
            onChange={(next) => {
              setLocal({ crossWorkspace: next });
              void ipcCallResult("appState", "set", { cliCrossWorkspace: next });
            }}
            label={policyLabel}
            disabled={!enabled}
          />
        </SettingsRow>
        <SettingsSwitch
          label={t("agentCli.agentContext.label")}
          description={t("agentCli.agentContext.description")}
          checked={agentContext}
          disabled={!enabled}
          onChange={(next) => {
            setLocal({ agentContext: next });
            void ipcCallResult("appState", "set", { cliAgentContext: next });
          }}
        />
      </SettingsGroup>
    </SettingsPage>
  );
}

/** The chat tabs' text: a preview in it, then its font and its size. */
function ChatFontGroup() {
  const { t } = useTranslation("settings");
  const size = useChatFontStore((s) => s.size);
  const family = useChatFontStore((s) => s.family);
  const setSize = useChatFontStore((s) => s.setSize);
  const setFamily = useChatFontStore((s) => s.setFamily);
  const style = useChatFontStyle();
  const presets = useMemo(() => [{ value: "system-ui", label: t("chat.systemUi") }], [t]);

  return (
    <SettingsGroup title={t("chat.font")}>
      {/* As a chat tab shows it: a reply, with code in it, and a tool's line. */}
      <div
        className="chat-font flex flex-col gap-1 rounded-(--radius-control) border border-border bg-background px-3 py-2"
        style={style}
        data-testid="chat-font-preview"
      >
        <p className="md-preview chat-md">
          {t("chat.previewReply")
            .split("`")
            .map((part, i) =>
              // biome-ignore lint/suspicious/noArrayIndexKey: the parts keep their order
              i % 2 === 1 ? <code key={i}>{part}</code> : <span key={i}>{part}</span>,
            )}
        </p>
        <span className="text-app-ui-sm text-muted-foreground">{t("chat.previewTool")}</span>
      </div>

      <FontFamilyRow scope="chat" family={family} setFamily={setFamily} presets={presets} />

      <SettingsRow
        label={t("chat.fontSize")}
        description={t("chat.fontSizeHint")}
        dirty={size !== undefined}
        onReset={() => setSize(undefined)}
      >
        <NumberInput
          value={size ?? CHAT_FONT_SIZE}
          onChange={setSize}
          min={CHAT_FONT_SIZE_MIN}
          max={CHAT_FONT_SIZE_MAX}
          step={1}
          suffix="px"
          ariaLabel={t("chat.ariaFontSize")}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}
