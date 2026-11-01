/**
 * Agent CLI panel: the nexus command that agents in the app's terminals use
 * to drive NexusCode. A master switch, what nexus may do to other workspaces,
 * and whether Claude Code sessions are told about it when they start.
 */

import { useId } from "react";
import { useTranslation } from "react-i18next";
import { ipcCallResult } from "../../../ipc/client";
import { type CrossWorkspacePolicy, useAgentCliStore } from "../../../state/stores/agent-cli";
import { Switch } from "../../ui/switch";
import { SettingsSection } from "../section";
import { SegmentedControl } from "../segmented-control";

function SwitchRow(props: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col gap-1 min-w-0">
        <label htmlFor={id} className="text-app-body text-foreground cursor-pointer">
          {props.label}
        </label>
        <p className="text-app-ui-sm text-muted-foreground">{props.description}</p>
      </div>
      <Switch
        id={id}
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={props.onChange}
        className="shrink-0 mt-1"
      />
    </div>
  );
}

export function AgentCliPanel() {
  const { t } = useTranslation("settings");
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
    <div className="flex flex-col gap-6">
      <SwitchRow
        label={t("agentCli.enabled.label")}
        description={t("agentCli.enabled.description")}
        checked={enabled}
        onChange={(next) => {
          setLocal({ enabled: next });
          void ipcCallResult("appState", "set", { cliEnabled: next });
        }}
      />
      <SettingsSection label={policyLabel}>
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
        <p className="text-app-ui-sm text-muted-foreground">
          {t("agentCli.crossWorkspace.description")}
        </p>
      </SettingsSection>
      <SwitchRow
        label={t("agentCli.agentContext.label")}
        description={t("agentCli.agentContext.description")}
        checked={agentContext}
        disabled={!enabled}
        onChange={(next) => {
          setLocal({ agentContext: next });
          void ipcCallResult("appState", "set", { cliAgentContext: next });
        }}
      />
    </div>
  );
}
