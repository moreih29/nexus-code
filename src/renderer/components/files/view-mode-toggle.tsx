import { List, ListTree } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { Button } from "../ui/button";

export interface ViewModeToggleProps {
  viewMode: "list" | "tree";
  onViewModeChange: (next: "list" | "tree") => void;
  disabled?: boolean;
}

export function computeNextViewMode(current: "list" | "tree"): "list" | "tree" {
  return current === "tree" ? "list" : "tree";
}

const TOGGLE_ON_CLASS = "bg-[var(--state-active-bg)] text-foreground ring-1 ring-inset ring-ring";

export function ViewModeToggle({
  viewMode,
  onViewModeChange,
  disabled = false,
}: ViewModeToggleProps) {
  const { t } = useTranslation("files");
  const isTree = viewMode === "tree";
  const toggleLabel = isTree ? t("search.viewMode.viewAsList") : t("search.viewMode.viewAsTree");

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-pressed={isTree}
      tooltip={toggleLabel}
      disabled={disabled}
      className={cn("shrink-0", isTree && TOGGLE_ON_CLASS)}
      onClick={() => onViewModeChange(computeNextViewMode(viewMode))}
    >
      {isTree ? <ListTree aria-hidden="true" /> : <List aria-hidden="true" />}
    </Button>
  );
}
