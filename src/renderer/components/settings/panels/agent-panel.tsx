import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AGENT_LIST_VIEWS, DEFAULT_AGENT_LIST_VIEW } from "../../../../shared/agent-list/view";
import {
  LIMIT_RESUME_BOUNDS,
  LIMIT_RESUME_DEFAULTS,
} from "../../../../shared/chat/limit-resume-settings";
import { DEFAULT_TASK_AGENT } from "../../../../shared/sessions/task-agent";
import { ipcCallResult } from "../../../ipc/client";
import {
  CHAT_FONT_SIZE,
  CHAT_FONT_SIZE_MAX,
  CHAT_FONT_SIZE_MIN,
} from "../../../services/chat/chat-font";
import { type CrossWorkspacePolicy, useAgentCliStore } from "../../../state/stores/agent-cli";
import { useAgentListViewStore } from "../../../state/stores/agent-list-view";
import { useChatFontStore, useChatFontStyle } from "../../../state/stores/chat-font";
import { useNotificationsStore } from "../../../state/stores/notifications";
import { useTerminalStore } from "../../../state/stores/terminal";
import { NumberInput } from "../../ui/number-input";
import { taskAgentOptions } from "../../workspace/task-agent-options";
import { FontFamilyRow } from "../font-family-row";
import {
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "../section";
import { SegmentedControl } from "../segmented-control";

export function AgentPanel() {
  const { t } = useTranslation("settings");
  const taskAgent = useTerminalStore((s) => s.taskAgent);
  const setTaskAgent = useTerminalStore((s) => s.setTaskAgent);
  const agentListView = useAgentListViewStore((s) => s.defaultView);
  const setAgentListView = useAgentListViewStore((s) => s.setDefault);
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

        <SettingsRow
          label={t("terminal.agentListView.label")}
          description={t("terminal.agentListView.hint")}
          dirty={agentListView !== undefined}
          onReset={() => setAgentListView(undefined)}
        >
          <SegmentedControl
            options={AGENT_LIST_VIEWS.map((value) => ({
              value,
              label: t(`common:agentList.view.${value}`),
            }))}
            value={agentListView ?? DEFAULT_AGENT_LIST_VIEW}
            onChange={setAgentListView}
            label={t("terminal.agentListView.label")}
          />
        </SettingsRow>
      </SettingsGroup>

      <ChatFontGroup />

      <LimitResumeGroup />

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

function LimitResumeGroup() {
  const { t } = useTranslation("settings");
  const enabled = useNotificationsStore((s) => s.limitResume);
  const options = useNotificationsStore((s) => s.limitResumeOptions);
  const setOptions = useNotificationsStore((s) => s.setLimitResumeOptions);
  const message = options.chatLimitResumeMessage;
  const messageId = useId();
  const [draft, setDraft] = useState<string | null>(null);

  function setEnabled(next: boolean) {
    useNotificationsStore.getState().setLimitResume(next);
    void ipcCallResult("appState", "set", { chatLimitResume: next });
  }

  const numbers: {
    key: keyof typeof LIMIT_RESUME_BOUNDS;
    label: string;
    description?: string;
    suffix: string;
  }[] = [
    {
      key: "chatLimitResumeDelayMinutes",
      label: t("chat.limitResume.delay"),
      suffix: t("chat.limitResume.minutes"),
    },
    {
      key: "chatLimitResumeMaxTries",
      label: t("chat.limitResume.maxTries"),
      suffix: t("chat.limitResume.checks"),
    },
    {
      key: "chatLimitResumeDeadlineHours",
      label: t("chat.limitResume.deadline"),
      description: t("chat.limitResume.deadlineHint"),
      suffix: t("chat.limitResume.hours"),
    },
  ];

  return (
    <SettingsGroup title={t("chat.limits")}>
      <SettingsSwitch
        label={t("chat.limitResume.label")}
        description={t("chat.limitResume.description")}
        checked={enabled}
        onChange={setEnabled}
        dirty={!enabled}
        onReset={() => setEnabled(true)}
      />
      <fieldset disabled={!enabled} className="flex min-w-0 flex-col gap-3.5 disabled:opacity-50">
        {numbers.map(({ key, label, description, suffix }) => (
          <SettingsRow
            key={key}
            label={label}
            description={description}
            dirty={options[key] !== LIMIT_RESUME_DEFAULTS[key]}
            onReset={() => setOptions({ [key]: LIMIT_RESUME_DEFAULTS[key] })}
          >
            <NumberInput
              {...LIMIT_RESUME_BOUNDS[key]}
              value={options[key]}
              onChange={(value) => setOptions({ [key]: value })}
              suffix={suffix}
              ariaLabel={label}
            />
          </SettingsRow>
        ))}
        <SettingsSection
          label={t("chat.limitResume.message")}
          htmlFor={messageId}
          dirty={message.trim() !== LIMIT_RESUME_DEFAULTS.chatLimitResumeMessage}
          onReset={() => {
            setDraft(null);
            setOptions({ chatLimitResumeMessage: LIMIT_RESUME_DEFAULTS.chatLimitResumeMessage });
          }}
        >
          <input
            id={messageId}
            type="text"
            className="w-full rounded-(--radius-control) border border-border bg-background px-2 py-1 text-app-body text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
            placeholder={t("common:chat.limit_resume.prompt")}
            value={draft ?? message}
            onChange={(event) =>
              setDraft(event.currentTarget.value.replace(/[\u2028\u2029]/gu, " "))
            }
            onBlur={() => {
              if (draft !== null && draft.trim() !== message) {
                setOptions({ chatLimitResumeMessage: draft.trim() });
              }
              setDraft(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing)
                event.currentTarget.blur();
            }}
          />
        </SettingsSection>
      </fieldset>
    </SettingsGroup>
  );
}

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
