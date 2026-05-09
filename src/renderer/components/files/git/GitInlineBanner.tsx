/**
 * GitInlineBanner presents panel-local notices such as operation failures.
 */
import { CircleAlert, Info } from "lucide-react";
import { cn } from "@/utils/cn";
import { Button } from "../../ui/button";

type GitInlineBannerVariant = "info" | "warning" | "error" | "success";

interface GitInlineBannerProps {
  variant?: GitInlineBannerVariant;
  message: string;
  details?: string;
  actionLabel?: string;
  onAction?: () => void;
}

function bannerClass(variant: GitInlineBannerVariant): string {
  switch (variant) {
    case "error":
      return "border-destructive/60 bg-destructive/10 text-destructive";
    case "warning":
      return "border-mist-border bg-frosted-veil text-warning";
    case "success":
      return "border-mist-border bg-frosted-veil text-success";
    default:
      return "border-mist-border bg-frosted-veil text-muted-foreground";
  }
}

export function GitInlineBanner({
  variant = "info",
  message,
  details,
  actionLabel,
  onAction,
}: GitInlineBannerProps) {
  const Icon = variant === "error" || variant === "warning" ? CircleAlert : Info;

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
        <p className="break-words text-foreground">{message}</p>
        {details ? <p className="mt-0.5 break-words text-muted-foreground">{details}</p> : null}
      </div>
      {actionLabel && onAction ? (
        <Button type="button" variant="ghost" size="sm" className="h-6 px-2" onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}
