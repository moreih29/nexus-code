import i18next from "i18next";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TranscriptRecording } from "../../../shared/notes/transcript";
import type { VoiceNameStatus } from "../../../shared/notes/voice-names";
import {
  loadVoiceMemory,
  recordingHasVoiceAudio,
  useVoiceMemory,
  voiceMemoryApi,
} from "../../services/notes/voice-memory";
import { useVoicePrintAvailable } from "../../services/notes/voice-print";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { showConfirmDialog } from "../ui/confirm-dialog";
import { Dialog } from "../ui/dialog";
import { DialogHeader } from "../ui/dialog-header";

let pendingConsent: Promise<VoiceNameStatus> | undefined;

export async function consentToVoiceMemory(): Promise<VoiceNameStatus | null> {
  const status = await loadVoiceMemory();
  if (!status?.available || status.consent !== "pending") return status;
  pendingConsent ??= voiceMemoryApi
    .claimConsent()
    .then(({ prompt, status }) => {
      if (!prompt) return status;
      return showConfirmDialog({
        title: i18next.t("notes:voiceMemory.consent.title"),
        description: i18next.t("notes:voiceMemory.consent.description"),
        hint: i18next.t("notes:voiceMemory.consent.hint"),
        cancelLabel: i18next.t("notes:voiceMemory.consent.decline"),
        confirmLabel: i18next.t("notes:voiceMemory.consent.accept"),
      }).then(voiceMemoryApi.consent);
    })
    .finally(() => {
      pendingConsent = undefined;
    });
  return pendingConsent;
}

export function SpeakerNameDialog({
  speaker,
  initial,
  names,
  workspaceId,
  noteId,
  takes,
  audioRemoved,
  onSave,
  onClose,
}: {
  speaker: string;
  initial: string;
  names: readonly string[];
  workspaceId: string;
  noteId: string;
  takes: TranscriptRecording["takes"];
  audioRemoved: boolean;
  onSave: (name: string, remember: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("notes");
  const status = useVoiceMemory((s) => s.status);
  const model = useVoicePrintAvailable();
  const [name, setName] = useState(initial);
  const [remember, setRemember] = useState(true);
  const [audio, setAudio] = useState<boolean | null>(null);
  useEffect(() => {
    let current = true;
    void recordingHasVoiceAudio({ workspaceId, noteId }, { takes, audioRemoved })
      .catch(() => false)
      .then((value) => {
        if (current) setAudio(value);
      });
    return () => {
      current = false;
    };
  }, [workspaceId, noteId, takes, audioRemoved]);
  const inputId = useId();
  const namesId = useId();
  const checkId = useId();
  const hintId = useId();
  const reason =
    audioRemoved || !takes.length || audio === false
      ? t("voiceMemory.audioMissing")
      : !status || audio === null
        ? t("voiceMemory.loading")
        : !status.available
          ? t("voiceMemory.unavailable")
          : status.consent === "declined"
            ? t("voiceMemory.declinedHint")
            : !model
              ? t("voiceMemory.modelUnavailable")
              : null;
  const checked = reason === null && remember;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="sm"
      aria-describedby={hintId}
    >
      <DialogHeader title={t("voiceMemory.nameTitle", { speaker })} />
      <form
        className="mt-4 flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(name, checked);
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          {t("transcript.namePlaceholder")}
        </label>
        <input
          id={inputId}
          list={namesId}
          value={name}
          maxLength={80}
          placeholder={t("transcript.namePlaceholder")}
          onChange={(e) => setName(e.target.value)}
          className="h-8 rounded-(--radius-control) border border-border bg-background px-2 text-app-ui-sm text-foreground focus-visible:outline focus-visible:outline-ring"
          data-testid="speaker-name-input"
        />
        <datalist id={namesId}>
          {names.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        <div className="flex items-start gap-2">
          <Checkbox
            id={checkId}
            checked={checked}
            disabled={reason !== null}
            aria-describedby={hintId}
            onCheckedChange={(value) => setRemember(value === true)}
          />
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={checkId} className="text-app-ui-sm text-foreground">
              {t("voiceMemory.remember")}
            </label>
            <p id={hintId} className="text-app-ui-sm text-muted-foreground">
              {reason ??
                t("voiceMemory.rememberHint", {
                  name: name.trim() || t("voiceMemory.nameExample"),
                })}
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {t("common:action.cancel")}
          </Button>
          <Button type="submit" size="sm">
            {t("common:action.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
