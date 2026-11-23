import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { dateTimeFormat } from "@/utils/intl-format";
import type { VoiceNamePerson } from "../../../../shared/notes/voice-names";
import { useIpcAction } from "../../../hooks/use-ipc-action";
import {
  loadVoiceMemory,
  useVoiceMemory,
  voiceMemoryApi,
} from "../../../services/notes/voice-memory";
import { KeychainLockedRow, useKeychainLocked } from "../../keychain/keychain-locked";
import { Button } from "../../ui/button";
import { showConfirmDialog } from "../../ui/confirm-dialog";
import { showToast } from "../../ui/toast";
import { SettingsGroup, SettingsSwitch } from "../section";

const heardOn = dateTimeFormat("en-US", { month: "2-digit", day: "2-digit" });

export function RememberedVoicesGroup() {
  const { t } = useTranslation("notes");
  const status = useVoiceMemory((s) => s.status);
  // Kept in a keychain not open yet: nothing to show or change until it opens.
  const locked = useKeychainLocked("voices");
  const [people, setPeople] = useState<VoiceNamePerson[] | null>(null);
  const [busy, setBusy] = useState(false);
  const { run, cancel, state } = useIpcAction<VoiceNamePerson[]>({ onSuccess: setPeople });
  const load = useCallback(() => {
    cancel();
    run(async () => {
      const current = status ?? (await loadVoiceMemory());
      if (!current) throw new Error("Voice memory status unavailable");
      return current.available ? voiceMemoryApi.list() : [];
    });
  }, [cancel, run, status]);

  useEffect(load, [load]);

  const update = async (task: () => Promise<unknown>, error: string) => {
    setBusy(true);
    try {
      await task();
    } catch {
      showToast({ kind: "error", message: error });
    } finally {
      setBusy(false);
    }
  };

  const removeAll = async () => {
    const confirmed = await showConfirmDialog({
      title: t("voiceMemory.settings.deleteAllTitle"),
      description: t("voiceMemory.settings.deleteAllDescription"),
      confirmLabel: t("voiceMemory.settings.deleteAll"),
      variant: "destructive",
    });
    if (confirmed) await update(voiceMemoryApi.clear, t("voiceMemory.settings.removeFailed"));
  };

  return (
    <SettingsGroup
      title={t("voiceMemory.settings.title")}
      description={t("voiceMemory.settings.description")}
    >
      {state.status === "error" && (
        <div className="flex items-center justify-between gap-2">
          <p role="alert" className="text-app-ui-sm text-muted-foreground">
            {t("voiceMemory.settings.loadFailed")}
          </p>
          <Button size="sm" variant="outline" onClick={load}>
            {t("common:action.retry")}
          </Button>
        </div>
      )}
      {status?.available === false && (
        <p className="text-app-ui-sm text-muted-foreground">{t("voiceMemory.unavailable")}</p>
      )}
      {status?.available && locked && <KeychainLockedRow item="voices" />}
      {status?.available && !locked && (
        <>
          <div className="flex flex-col gap-2">
            <SettingsSwitch
              label={t("voiceMemory.settings.suggest")}
              description={t("voiceMemory.settings.suggestHint")}
              checked={status.suggest}
              disabled={busy}
              onChange={(suggest) =>
                void update(
                  () => voiceMemoryApi.configure({ suggest }),
                  t("voiceMemory.settings.updateFailed"),
                )
              }
            />
            <SettingsSwitch
              label={t("voiceMemory.settings.expire")}
              description={t("voiceMemory.settings.expireHint")}
              checked={status.expire}
              disabled={busy}
              onChange={(expire) =>
                void update(
                  () => voiceMemoryApi.configure({ expire }),
                  t("voiceMemory.settings.updateFailed"),
                )
              }
            />
          </div>
          {people?.length === 0 && (
            <p className="text-app-ui-sm text-muted-foreground">
              {t("voiceMemory.settings.empty")}
            </p>
          )}
          {people && people.length > 0 && (
            <div className="flex flex-col gap-1">
              {people.map(({ name, count, lastHeard }) => (
                <div
                  key={name}
                  className="flex items-center gap-3 rounded-(--radius-control) px-2 py-1.5 hover:bg-[var(--state-hover-bg)]"
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-app-body text-foreground">{name}</span>
                    <span className="text-app-micro text-muted-foreground">
                      {t("voiceMemory.settings.person", { count, date: heardOn.format(lastHeard) })}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label={t("voiceMemory.settings.deleteNamed", { name })}
                    onClick={() =>
                      void update(
                        () => voiceMemoryApi.remove(name),
                        t("voiceMemory.settings.removeFailed"),
                      )
                    }
                  >
                    {t("voiceMemory.settings.delete")}
                  </Button>
                </div>
              ))}
              <Button
                size="sm"
                variant="outline"
                className="self-end"
                disabled={busy}
                onClick={() => void removeAll()}
              >
                {t("voiceMemory.settings.deleteAll")}
              </Button>
            </div>
          )}
        </>
      )}
    </SettingsGroup>
  );
}
