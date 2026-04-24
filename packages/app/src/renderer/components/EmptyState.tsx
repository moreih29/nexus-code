import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

type Action = { label: string; shortcut?: string; onClick: () => void };

export function EmptyState(props: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: Action;
}) {
  const Icon = props.icon;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
      <Icon size={24} strokeWidth={1.75} aria-hidden className="text-muted-foreground" />
      <h2 className="text-sm font-medium text-foreground">{props.title}</h2>
      <p className="text-xs text-muted-foreground leading-normal max-w-xs">{props.description}</p>
      {props.action && (
        <div className="flex items-center gap-2 mt-1">
          <Button size="sm" variant="outline" onClick={props.action.onClick}>
            {props.action.label}
          </Button>
          {props.action.shortcut && (
            <kbd className="text-xs text-muted-foreground font-mono">{props.action.shortcut}</kbd>
          )}
        </div>
      )}
    </div>
  );
}
