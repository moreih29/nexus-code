import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/utils/cn";

export function ToggleChevron({ open, className }: { open: boolean; className?: string }) {
  const Icon = open ? ChevronUp : ChevronDown;
  return <Icon aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground", className)} />;
}
