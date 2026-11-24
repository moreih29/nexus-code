import { ChevronDown, Sparkles } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { useVoicePrintAvailable } from "../../services/notes/voice-print";
import { useNoteSummarySettings } from "../../state/stores/note-summary";
import { useSettingsUIStore } from "../../state/stores/settings-ui";
import { Button } from "../ui/button";
import { Popover } from "../ui/popover";

export function AfterRecording() {
  const { t } = useTranslation("notes");
  const summary = useNoteSummarySettings((s) => s.enabled);
  const voicePrint = useVoicePrintAvailable();
  const [open, setOpen] = useState(false);
  const label = summary ? t("recorder.after.on") : t("recorder.after.off");
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label={t("recorder.after.title")}
      side="bottom"
      align="end"
      className="w-72 p-3"
      testId="note-after-recording"
      trigger={
        <button
          type="button"
          className="inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-(--radius-control) px-1.5 text-app-ui-sm text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground aria-expanded:bg-[var(--state-active-bg)] aria-expanded:text-foreground"
          aria-label={`${t("recorder.after.title")} · ${label}`}
          title={t("recorder.after.title")}
          data-testid="note-after-recording-toggle"
        >
          <Sparkles className="size-3.5" aria-hidden="true" />
          <span className="hidden @min-[720px]/note:inline">{label}</span>
          <ChevronDown className="size-3" aria-hidden="true" />
        </button>
      }
    >
      <AfterRecordingSteps
        summary={summary}
        voicePrint={voicePrint}
        onSettings={() => {
          setOpen(false);
          useSettingsUIStore.getState().openSettingsAt("notes");
        }}
      />
    </Popover>
  );
}

export function AfterRecordingSteps({
  summary,
  voicePrint,
  onSettings,
}: {
  summary: boolean;
  voicePrint: boolean;
  onSettings: () => void;
}) {
  const { t } = useTranslation("notes");
  const steps = [
    { key: "refine", label: t("transcript.refine"), hint: t("recorder.after.refineHint") },
    ...(voicePrint
      ? [
          {
            key: "speakers",
            label: t("recorder.after.speakers"),
            hint: t("recorder.after.speakersHint"),
          },
        ]
      : []),
    {
      key: "summary",
      label: t("recorder.after.summary"),
      hint: summary ? t("recorder.after.summaryOn") : t("recorder.after.summaryOff"),
      off: !summary,
    },
  ];
  return (
    <div className="flex flex-col gap-2.5">
      <p className="font-medium text-foreground">{t("recorder.after.title")}</p>
      <ol className="flex flex-col gap-2">
        {steps.map((step, index) => (
          <li key={step.key} className="flex gap-2" data-step={step.key}>
            <span
              className={cn(
                "inline-flex size-4 shrink-0 items-center justify-center rounded-full border text-app-micro tabular-nums",
                step.off
                  ? "border-dashed border-border text-muted-foreground"
                  : "border-ring text-foreground",
              )}
              aria-hidden="true"
            >
              {index + 1}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className={step.off ? "text-muted-foreground" : "text-foreground"}>
                {step.label}
              </span>
              <span className="text-app-micro text-muted-foreground">{step.hint}</span>
            </span>
          </li>
        ))}
      </ol>
      <Button variant="outline" size="sm" className="self-start" onClick={onSettings}>
        {t("recorder.after.settings")}
      </Button>
    </div>
  );
}
