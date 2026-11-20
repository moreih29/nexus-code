import { Minus, Plus } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  peopleIn,
  protectedVoiceCount,
  type TranscriptRecording,
} from "../../../shared/notes/transcript";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { DialogHeader } from "../ui/dialog-header";

export function RegroupDialog({
  recording,
  onClose,
  onRegroup,
}: {
  recording: TranscriptRecording;
  onClose: () => void;
  onRegroup: (count: number) => void;
}) {
  const { t } = useTranslation("notes");
  const countId = useId();
  const count = peopleIn(recording);
  const min = Math.max(1, protectedVoiceCount(recording));
  const saved = recording.participantCount;
  const initial = typeof saved === "number" ? saved : saved === "7+" ? 7 : Math.min(2, count);
  const max = Math.max(min, initial, recording.lines.length);
  const [value, setValue] = useState(() => String(Math.max(min, initial)));
  const target = Number(value);
  const valid = Number.isInteger(target) && target >= min && target <= max;
  const step = (amount: number) =>
    setValue(String(Math.min(max, Math.max(min, (valid ? target : min) + amount))));

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="sm"
    >
      <DialogHeader
        title={t("transcript.regroup.title")}
        description={t("transcript.regroup.hint")}
      />
      <form
        className="mt-4 flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) onRegroup(target);
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={countId} className="text-app-ui-sm text-muted-foreground">
            {t("recorder.participants")}
          </label>
          <div className="flex items-center rounded-(--radius-control) border border-border bg-background">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={valid && target <= min}
              aria-label={t("transcript.regroup.fewer")}
              onClick={() => step(-1)}
            >
              <Minus className="size-3.5" aria-hidden="true" />
            </Button>
            <input
              id={countId}
              type="number"
              min={min}
              max={max}
              required
              value={value}
              onChange={(event) => setValue(event.target.value)}
              className="w-14 appearance-none border-x border-border bg-transparent py-1 text-center text-app-ui-sm tabular-nums [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={valid && target >= max}
              aria-label={t("transcript.regroup.more")}
              onClick={() => step(1)}
            >
              <Plus className="size-3.5" aria-hidden="true" />
            </Button>
          </div>
        </div>
        <div
          className="rounded-(--radius-control) border border-border bg-background px-2 py-1.5 text-app-ui-sm"
          aria-live="polite"
        >
          {valid
            ? t("transcript.regroup.preview", { count, target })
            : t("transcript.regroup.range", { min, max })}
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {t("common:action.cancel")}
          </Button>
          <Button type="submit" size="sm" disabled={!valid}>
            {t("transcript.regroup.confirm")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
