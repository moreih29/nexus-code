import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { RecordingSummarySettings } from "../../../../shared/notes/summary";
import { ipcCallResult, mustSucceed } from "../../../ipc/client";
import {
  borrowedClaudeModels,
  useClaudeModelCatalog,
} from "../../../services/chat/claude/model-catalog";
import { claudeModelLabel } from "../../../services/chat/claude/settings-defaults";
import {
  summaryCatalogKey,
  summaryModels,
  summaryProfile,
} from "../../../services/notes/summary-models";
import { useAgentProfilesStore } from "../../../state/stores/agent-profiles";
import { useNoteSummarySettings } from "../../../state/stores/note-summary";
import { profileName } from "../../agent-profiles/profile-badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";
import { showToast } from "../../ui/toast";
import { SettingsGroup, SettingsRow, SettingsSwitch } from "../section";

export function NoteSummaryGroup() {
  const { t } = useTranslation("notes");
  const settings = useNoteSummarySettings();
  const config = useAgentProfilesStore((s) => s.config);
  const { profiles, defaultId, profileId, profile } = summaryProfile(config, settings);
  const profileKey = summaryCatalogKey(profileId, profile);
  const discovered = useClaudeModelCatalog((catalog) =>
    borrowedClaudeModels(catalog, profileKey, ""),
  );
  const { models, defaultLabel, choices } = summaryModels(profile, discovered);
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
            {choices.map(({ value, displayName }) => (
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
