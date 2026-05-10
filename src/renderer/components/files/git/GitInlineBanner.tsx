/**
 * GitInlineBanner presents panel-local notices such as operation failures.
 */
import { CircleAlert, Info } from "lucide-react";
import { cn } from "@/utils/cn";
import { Button } from "../../ui/button";

type GitInlineBannerVariant = "info" | "warning" | "error" | "success";
type GitInlineBannerActionVariant = "default" | "destructive" | "ghost";

export interface GitInlineBannerAction {
  label: string;
  onAction: () => void;
  variant?: GitInlineBannerActionVariant;
}

interface GitInlineBannerProps {
  variant?: GitInlineBannerVariant;
  message: string;
  details?: string;
  actionLabel?: string;
  onAction?: () => void;
  actions?: GitInlineBannerAction[];
}

// Per design.md "almost monochromatic" mission, only `destructive` carries a
// non-monochrome semantic. Warning / success / info all render with the same
// frosted-veil chrome; the icon (CircleAlert vs Info) carries severity.
function bannerClass(variant: GitInlineBannerVariant): string {
  if (variant === "error") return "border-destructive/60 bg-destructive/10 git-destructive-text";
  return "border-mist-border bg-frosted-veil text-foreground";
}

export function GitInlineBanner({
  variant = "info",
  message,
  details,
  actionLabel,
  onAction,
  actions,
}: GitInlineBannerProps) {
  const Icon = variant === "error" || variant === "warning" ? CircleAlert : Info;
  const renderedActions =
    actions ?? (actionLabel && onAction ? [{ label: actionLabel, onAction }] : []);

  return (
    <div
      className={cn(
        "mx-2 my-1 flex items-start gap-2 rounded-md border px-2 py-1.5 text-app-ui-sm",
        bannerClass(variant),
      )}
      role={variant === "error" ? "alert" : "status"}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="whitespace-pre-wrap break-words text-foreground">{message}</p>
        {details ? (
          <p className="mt-0.5 whitespace-pre-wrap break-words text-muted-foreground">{details}</p>
        ) : null}
      </div>
      {renderedActions.length > 0 ? (
        <div className="flex shrink-0 items-center gap-1">
          {renderedActions.map((action) => (
            <Button
              key={action.label}
              type="button"
              variant={action.variant ?? "ghost"}
              size="sm"
              className="h-6 px-2"
              onClick={action.onAction}
            >
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
