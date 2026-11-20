import { useId } from "react";
import { useTranslation } from "react-i18next";
import { INSTRUCTION_LIMIT, InstructionTextSchema } from "../../../shared/chat/instructions";
import { cn } from "../../utils/cn";

export function InstructionField({
  label,
  text,
  onChange,
  rows = 3,
}: {
  label: string;
  text: string;
  onChange: (text: string) => void;
  rows?: number;
}) {
  const { t } = useTranslation("settings");
  const detail = useId();
  const invalid = !InstructionTextSchema.safeParse(text).success;
  const tokens = Math.ceil(new TextEncoder().encode(text).length / 4);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <textarea
        aria-label={label}
        aria-describedby={detail}
        aria-invalid={invalid || undefined}
        value={text}
        onChange={(event) => onChange(event.currentTarget.value)}
        rows={rows}
        className={cn(
          "app-scrollbar w-full resize-y rounded-(--radius-control) border border-border bg-background p-2 text-app-body text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring",
          invalid && "border-[var(--state-error-fg)]",
        )}
      />
      <p
        id={detail}
        className={cn(
          "text-right text-app-ui-sm text-muted-foreground",
          invalid && "text-[var(--state-error-fg)]",
        )}
      >
        {invalid
          ? t(
              text.length > INSTRUCTION_LIMIT ? "instructions.tooLong" : "instructions.invalidText",
              { max: INSTRUCTION_LIMIT },
            )
          : t("instructions.count", { chars: text.length, tokens })}
      </p>
    </div>
  );
}

export function InstructionPreview({ text }: { text: string }) {
  const { t } = useTranslation("settings");
  return (
    <pre className="app-scrollbar max-h-48 overflow-y-auto whitespace-pre-wrap wrap-break-word rounded-(--radius-control) border border-border bg-background p-2 font-mono text-app-ui-sm">
      {text || <span className="text-muted-foreground">{t("instructions.empty")}</span>}
    </pre>
  );
}
