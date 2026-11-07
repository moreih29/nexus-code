/**
 * Agent manager panel: whether the manager runs with the app and as which
 * agent, which sessions' changes it is told of, and what it may do with
 * another session's permission request. Its reports as desktop
 * notifications are under Notifications.
 */

import { useTranslation } from "react-i18next";
import {
  MANAGER_NOTIFY,
  MANAGER_PERMISSIONS,
  type ManagerNotify,
  type ManagerPermissions,
} from "../../../../shared/manager/manager";
import type { ChatAgent } from "../../../../shared/sessions/task-agent";
import { useManagerStore } from "../../../state/stores/manager";
import { taskAgentOptions } from "../../workspace/task-agent-options";
import { SettingsGroup, SettingsPage, SettingsRow, SettingsSwitch } from "../section";
import { SegmentedControl } from "../segmented-control";

export function ManagerPanel() {
  const { t } = useTranslation("settings");
  const enabled = useManagerStore((s) => s.enabled);
  const agent = useManagerStore((s) => s.agent);
  const notify = useManagerStore((s) => s.notify);
  const permissions = useManagerStore((s) => s.permissions);
  const setSettings = useManagerStore((s) => s.setSettings);

  return (
    <SettingsPage>
      <SettingsGroup>
        <SettingsSwitch
          label={t("manager.enabled.label")}
          description={t("manager.enabled.description")}
          checked={enabled}
          onChange={(next) => setSettings({ enabled: next })}
        />
        <SettingsRow label={t("manager.agent.label")} description={t("manager.agent.description")}>
          <SegmentedControl<ChatAgent>
            options={taskAgentOptions().flatMap((option) =>
              option.value === "terminal" ? [] : [{ ...option, value: option.value }],
            )}
            value={agent}
            onChange={(next) => setSettings({ agent: next })}
            label={t("manager.agent.label")}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("manager.reports")}>
        <SettingsRow
          label={t("manager.notify.label")}
          description={t("manager.notify.description")}
        >
          <SegmentedControl<ManagerNotify>
            options={MANAGER_NOTIFY.map((value) => ({
              value,
              label: t(`manager.notify.${value}`),
            }))}
            value={notify}
            onChange={(next) => setSettings({ notify: next })}
            label={t("manager.notify.label")}
          />
        </SettingsRow>
        <SettingsRow
          label={t("manager.permissions.label")}
          description={t("manager.permissions.description")}
        >
          <SegmentedControl<ManagerPermissions>
            options={MANAGER_PERMISSIONS.map((value) => ({
              value,
              label: t(`manager.permissions.${value}`),
            }))}
            value={permissions}
            onChange={(next) => setSettings({ permissions: next })}
            label={t("manager.permissions.label")}
          />
        </SettingsRow>
      </SettingsGroup>
    </SettingsPage>
  );
}
