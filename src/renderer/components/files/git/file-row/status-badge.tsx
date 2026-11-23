import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { tooltipProps } from "../../../ui/tooltip";

interface GitStatusBadgeProps {
  code: string;
}

function statusBadgeClass(code: string): string {
  switch (code) {
    case "M":
    case "T":
    case "A":
    case "?":
      return "text-foreground font-semibold";
    case "D":
      return "git-destructive-text";
    case "R":
    case "C":
      return "text-muted-foreground";
    case "!":
      return "git-destructive-text bg-destructive/10 font-semibold";
    default:
      return "text-muted-foreground";
  }
}

const CODE_KIND: Record<string, string> = {
  M: "modified",
  T: "typeChanged",
  A: "added",
  "?": "untracked",
  D: "deleted",
  R: "renamed",
  C: "copied",
  "!": "conflict",
};

export function GitStatusBadge({ code }: GitStatusBadgeProps) {
  const { t } = useTranslation("files");
  const kind = CODE_KIND[code.slice(0, 1)];
  const label = kind ? t(`git.decorations.${kind}` as "git.decorations.modified") : code;
  return (
    <span
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-[3px] font-mono text-app-ui-sm leading-none",
        statusBadgeClass(code),
      )}
      role="img"
      aria-label={label}
      {...tooltipProps(label)}
    >
      {code.slice(0, 1)}
    </span>
  );
}
