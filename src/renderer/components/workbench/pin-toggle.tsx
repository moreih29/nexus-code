import { Pin } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { tooltipProps } from "../ui/tooltip";

export interface PinToggleProps {
  pinned: boolean;
  workspaceName: string;
  onToggle: () => void;
  draggable?: false;
  className?: string;
}

export function PinToggle({
  pinned,
  workspaceName,
  onToggle,
  draggable,
  className,
}: PinToggleProps) {
  const { t } = useTranslation();
  const tooltipLabel = pinned ? t("sidebar.unpin") : t("sidebar.pin_to_top");
  const ariaLabel = pinned
    ? t("sidebar.unpin_workspace_aria", { name: workspaceName })
    : t("sidebar.pin_workspace_aria", { name: workspaceName });

  function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    onToggle();
  }

  return (
    <button
      type="button"
      draggable={draggable}
      aria-pressed={pinned}
      aria-label={ariaLabel}
      {...tooltipProps(tooltipLabel)}
      onClick={handleClick}
      className={cn(
        "inline-flex items-center justify-center",
        "size-5 rounded-(--radius-control)",
        "transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        pinned
          ? "opacity-100 text-[var(--state-selected-indicator)]"
          : "opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 text-muted-foreground hover:text-foreground",
        className,
      )}
    >
      <Pin className="size-3" fill={pinned ? "currentColor" : "none"} aria-hidden="true" />
    </button>
  );
}
