// Codex's defaults (/config in a Codex tab): the model and reasoning effort
// a new conversation starts with, read from Codex's config and saved in the
// profile's config.toml. The composer's chips set only their tab's; the
// tab the dialog is opened in takes the new ones, as the CLI's session does.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CodexController } from "../../services/chat/codex-controller";
import type { ChatTabState } from "../../services/chat/store";
import { SettingsGroup, SettingsRow } from "../settings/section";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { DialogHeader } from "../ui/dialog-header";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { showToast } from "../ui/toast";

type Loaded = "loading" | { failed: string } | { model?: string; effort?: string };

export function CodexConfigDialog({
  controller,
  state,
  open,
  onClose,
}: {
  controller: CodexController;
  state: ChatTabState;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<Loaded>("loading");
  const [model, setModel] = useState<string | undefined>();
  const [effort, setEffort] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoaded("loading");
    setModel(undefined);
    setEffort(undefined);
    setBusy(false);
    controller.readDefaults().then(
      (defaults) => live && setLoaded(defaults),
      (err: Error) => live && setLoaded({ failed: err.message }),
    );
    return () => {
      live = false;
    };
  }, [controller, open]);

  const models = state.model.init?.models ?? [];
  const now = typeof loaded === "object" && !("failed" in loaded) ? loaded : null;
  const shownModel = model ?? now?.model;
  const levels = models.find((m) => m.value === shownModel)?.supportedEffortLevels ?? [];
  const shownEffort = effort ?? now?.effort;
  const changes = {
    model: model !== undefined && model !== now?.model ? model : undefined,
    effort: effort !== undefined && effort !== now?.effort ? effort : undefined,
  };
  const changed = (changes.model ? 1 : 0) + (changes.effort ? 1 : 0);

  const apply = async () => {
    setBusy(true);
    try {
      await controller.saveDefaults(changes);
      onClose();
    } catch (err) {
      setBusy(false);
      showToast({
        kind: "error",
        message: t("chat.config.failed", { error: (err as Error).message }),
      });
    }
  };

  // The current one, where the list no longer has it.
  const choices = (list: readonly string[], current: string | undefined) =>
    current && !list.includes(current) ? [...list, current] : [...list];

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()} size="md">
      <DialogHeader
        title={t("chat.config.codex.title")}
        description={t("chat.config.codex.description")}
        close
      />
      <div className="mt-4" data-testid="codex-config">
        {loaded === "loading" ? (
          <div className="py-8 text-center text-app-ui-sm text-muted-foreground">
            {t("chat.config.loading")}
          </div>
        ) : "failed" in loaded ? (
          <div className="py-8 text-center text-app-ui-sm text-[var(--state-error-fg)]">
            {t("chat.config.read_failed", { error: loaded.failed })}
          </div>
        ) : (
          <SettingsGroup title={t("chat.config.group.conversation")}>
            <SettingsRow
              label={t("chat.config.key.model")}
              description={t("chat.config.desc.model")}
              dirty={changes.model !== undefined}
              onReset={() => setModel(undefined)}
            >
              <Select value={shownModel ?? ""} onValueChange={setModel}>
                <SelectTrigger ariaLabel={t("chat.config.key.model")} className="w-44">
                  <SelectValue placeholder={t("chat.config.default")} />
                </SelectTrigger>
                <SelectContent>
                  {choices(
                    models.map((m) => m.value),
                    shownModel,
                  ).map((value) => (
                    <SelectItem key={value} value={value}>
                      {models.find((m) => m.value === value)?.displayName ?? value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsRow>
            {levels.length > 0 && (
              <SettingsRow
                label={t("chat.config.codex.effort")}
                dirty={changes.effort !== undefined}
                onReset={() => setEffort(undefined)}
              >
                <Select value={shownEffort ?? ""} onValueChange={setEffort}>
                  <SelectTrigger ariaLabel={t("chat.config.codex.effort")} className="w-44">
                    <SelectValue placeholder={t("chat.config.default")} />
                  </SelectTrigger>
                  <SelectContent>
                    {choices(levels, shownEffort).map((level) => (
                      <SelectItem key={level} value={level}>
                        {level}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsRow>
            )}
          </SettingsGroup>
        )}
      </div>
      <div className="mt-4 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
          {t("action.cancel")}
        </Button>
        <Button
          variant="default"
          size="sm"
          onClick={() => void apply()}
          disabled={busy || changed === 0}
          data-testid="codex-config-apply"
        >
          {changed > 0 ? t("chat.config.apply_count", { count: changed }) : t("action.apply")}
        </Button>
      </div>
    </Dialog>
  );
}
