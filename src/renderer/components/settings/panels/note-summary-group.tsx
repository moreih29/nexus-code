import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CLAUDE_MODEL_ALIASES } from "../../../../shared/agent-profiles/behavior";
import { profileDirectory } from "../../../../shared/agent-profiles/env";
import { defaultProfileId, profilesOf } from "../../../../shared/agent-profiles/profiles";
import type { RecordingSummarySettings } from "../../../../shared/notes/summary";
import { ipcCallResult, mustSucceed } from "../../../ipc/client";
import {
  borrowedClaudeModels,
  useClaudeModelCatalog,
} from "../../../services/chat/claude/model-catalog";
import { claudeModelLabel } from "../../../services/chat/claude/settings-defaults";
import { planUsageKey } from "../../../services/chat/plan-usage";
import { useAgentProfilesStore } from "../../../state/stores/agent-profiles";
import { useNoteSummarySettings } from "../../../state/stores/note-summary";
import { isWindows } from "../../../utils/platform";
import { profileName } from "../../agent-profiles/profile-badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";
import { showToast } from "../../ui/toast";
import { SettingsGroup, SettingsRow, SettingsSwitch } from "../section";

const fallbackModels = CLAUDE_MODEL_ALIASES.map((value) => ({
  value,
  displayName: claudeModelLabel(value),
}));

export function NoteSummaryGroup() {
  const { t } = useTranslation("notes");
  const settings = useNoteSummarySettings();
  const config = useAgentProfilesStore((s) => s.config);
  const profiles = profilesOf(config, "claude");
  const defaultId = defaultProfileId("claude");
  const profileId = settings.profileId ?? defaultId;
  const profile = profiles.find(({ id }) => id === profileId);
  const profileKey = JSON.stringify([
    planUsageKey("claude", undefined, profileId),
    profile ? profileDirectory(profile, isWindows()) : "",
  ]);
  const discovered = useClaudeModelCatalog((catalog) =>
    borrowedClaudeModels(catalog, profileKey, ""),
  );
  const custom = profile?.connection?.method === "custom" ? profile.connection : undefined;
  const models = custom
    ? custom.models.map(({ id, label }) => ({ value: id, displayName: label || id }))
    : (discovered ?? fallbackModels);
  const defaultLabel = custom
    ? models.find(({ value }) => value === custom.defaultModel)?.displayName
    : models.find(({ value }) => value === "default")?.displayName;
  const [busy, setBusy] = useState(false);
  const save = async (noteSummary: RecordingSummarySettings) => {
    setBusy(true);
    try {
      mustSucceed(await ipcCallResult("appState", "set", { noteSummary }));
    } catch {
      showToast({ kind: "error", message: t("summary.settings.saveFailed") });
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsGroup
      title={t("summary.settings.heading")}
      description={t("summary.settings.privacy")}
    >
      <SettingsSwitch
        label={t("summary.settings.enabled")}
        checked={settings.enabled}
        disabled={busy}
        onChange={(enabled) => void save({ ...settings, enabled })}
      />
      <SettingsRow label={t("summary.settings.profile")}>
        <Select
          value={profileId}
          disabled={busy}
          onValueChange={(id) =>
            void save({
              ...settings,
              profileId: id === defaultId ? undefined : id,
              model: undefined,
            })
          }
        >
          <SelectTrigger className="w-44" ariaLabel={t("summary.settings.profile")}>
            <SelectValue>
              {profile ? profileName(profile, t) : t("summary.settings.missingProfile")}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {profiles.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {profileName(entry, t)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>
      <SettingsRow label={t("summary.settings.model")}>
        <Select
          value={settings.model ? `model:${settings.model}` : "default"}
          disabled={busy || !profile}
          onValueChange={(model) =>
            void save({
              ...settings,
              model: model === "default" ? undefined : model.slice("model:".length),
            })
          }
        >
          <SelectTrigger className="w-44" ariaLabel={t("summary.settings.model")}>
            <SelectValue>
              {settings.model
                ? (models.find(({ value }) => value === settings.model)?.displayName ??
                  claudeModelLabel(settings.model))
                : t("summary.settings.defaultModel")}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default" description={defaultLabel}>
              {t("summary.settings.defaultModel")}
            </SelectItem>
            {models
              .filter(({ value }) => custom || value !== "default")
              .map(({ value, displayName }) => (
                <SelectItem key={value} value={`model:${value}`}>
                  {displayName ?? value}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </SettingsRow>
      <p className="text-app-ui-sm text-muted-foreground">{t("summary.settings.excluded")}</p>
    </SettingsGroup>
  );
}
