// The chevron of what opens in place, at the end of its control: a chip, a
// call's line, a thought. Down while folded, up while open, so a trailing
// right chevron is left to what goes to another view; a heading that folds
// the rows under it leads with its own (FoldChevron).

import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/utils/cn";

export function ToggleChevron({ open, className }: { open: boolean; className?: string }) {
  const Icon = open ? ChevronUp : ChevronDown;
  return <Icon aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground", className)} />;
}
