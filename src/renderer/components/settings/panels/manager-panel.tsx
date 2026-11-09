/**
 * Agent manager panel: whether the manager runs with the app, as which
 * agent and with which of its profiles, which sessions' changes it is told
 * of, and what it may do with another session's permission request. Its
 * reports as desktop notifications are under Notifications.
 */

import { useTranslation } from "react-i18next";
import { profileOf, profilesOf } from "../../../../shared/agent-profiles/profiles";
import {
  MANAGER_NOTIFY,
  MANAGER_PERMISSIONS,
  type ManagerNotify,
  type ManagerPermissions,
} from "../../../../shared/manager/manager";
import type { ChatAgent } from "../../../../shared/sessions/task-agent";
import { useAgentProfilesStore } from "../../../state/stores/agent-profiles";
import { useManagerStore } from "../../../state/stores/manager";
import { hasProfileChoice, profileName } from "../../agent-profiles/profile-badge";
import { ProfileSelect } from "../../agent-profiles/profile-select";
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
        <ProfileRow agent={agent} />
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

/**
 * The profile the manager runs with as `agent`: one of its profiles, or its
 * default as Settings › Profiles by workspace sets it. Not shown while the
 * agent has only its default profile.
 */
function ProfileRow({ agent }: { agent: ChatAgent }) {
  const { t } = useTranslation("settings");
  const config = useAgentProfilesStore((s) => s.config);
  const profiles = useManagerStore((s) => s.profiles);
  const setSettings = useManagerStore((s) => s.setSettings);
  if (!hasProfileChoice(config, agent)) return null;
  const all = profilesOf(config, agent);
  const chosen = profiles[agent];
  const fallback = profileOf(config, agent, config.defaults[agent]);
  const choose = (id: string | null) => {
    const { [agent]: _was, ...rest } = profiles;
    setSettings({ profiles: id ? { ...rest, [agent]: id } : rest });
  };
  return (
    <SettingsRow label={t("manager.profile.label")} description={t("manager.profile.description")}>
      <ProfileSelect
        agent={agent}
        profiles={all}
        value={chosen && all.some((p) => p.id === chosen) ? chosen : undefined}
        inherit={t("manager.profile.inherit", { name: profileName(fallback, t) })}
        onChange={choose}
        label={t("manager.profile.label")}
        className="w-48"
      />
    </SettingsRow>
  );
}
