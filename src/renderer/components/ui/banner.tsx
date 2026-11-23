import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";
import { cn } from "@/utils/cn";
import { Button } from "./button";
import { DetailsDisclosure } from "./details-disclosure";
import { IconButton } from "./icon-button";

export type BannerVariant = "info" | "warning" | "error" | "success";
export type BannerDisplay = "inline" | "bar";
export type BannerActionVariant = "default" | "destructive" | "ghost";

export interface BannerAction {
  label: string;
  onAction: () => void;
  variant?: BannerActionVariant;
}

export interface BannerProps {
  variant?: BannerVariant;
  display?: BannerDisplay;
  message: string;
  details?: string;
  actions?: BannerAction[];
  dismiss?: BannerDismiss;
  role?: "status" | "alert";
  "aria-live"?: "polite" | "assertive" | "off";
  className?: string;
}

export interface BannerDismiss {
  label: string;
  onDismiss: () => void;
}

export function BannerDismissButton({
  dismiss,
  className,
}: {
  dismiss: BannerDismiss;
  className?: string;
}) {
  return (
    <IconButton label={dismiss.label} size="xs" className={className} onClick={dismiss.onDismiss}>
      <X className="size-3.5" aria-hidden="true" />
    </IconButton>
  );
}

export function bannerColorClass(variant: BannerVariant): string {
  if (variant === "error") return "border-destructive/60 bg-destructive/10 git-destructive-text";
  return "border-border bg-muted text-foreground";
}

function BannerIcon({ variant, className }: { variant: BannerVariant; className?: string }) {
  if (variant === "success") {
    return (
      <CheckCircle2
        className={cn(className, "text-[var(--state-success-fg)]")}
        aria-hidden="true"
      />
    );
  }
  if (variant === "warning") {
    return (
      <CircleAlert className={cn(className, "text-[var(--state-warning-fg)]")} aria-hidden="true" />
    );
  }
  if (variant === "error") return <CircleAlert className={className} aria-hidden="true" />;
  return <Info className={cn(className, "text-[var(--state-info-fg)]")} aria-hidden="true" />;
}

function InlineBanner({
  variant = "info",
  message,
  details,
  actions = [],
  dismiss,
  role,
  "aria-live": ariaLive,
  className,
}: BannerProps) {
  return (
    <div
      className={cn(
        "mx-2 my-1 flex flex-col gap-2 rounded-(--radius-raised) border px-2 py-2 text-app-ui-sm",
        bannerColorClass(variant),
        className,
      )}
      role={role ?? (variant === "error" ? "alert" : "status")}
      aria-live={ariaLive}
    >
      <div className="flex items-start gap-2">
        <BannerIcon variant={variant} className="mt-0.5 size-3.5 shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="app-scrollbar max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-foreground">
            {message}
          </p>
          {details ? (
            <DetailsDisclosure details={details} className="text-muted-foreground" />
          ) : null}
        </div>
        {dismiss && <BannerDismissButton dismiss={dismiss} className="-my-0.5" />}
      </div>
      {actions.length > 0 ? (
        <div className="flex items-center justify-end gap-1">
          {actions.map((action) => (
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

function BarBanner({
  variant = "info",
  message,
  actions = [],
  dismiss,
  role,
  "aria-live": ariaLive,
  className,
}: BannerProps) {
  return (
    <div
      role={role ?? (variant === "error" ? "alert" : "status")}
      aria-live={ariaLive}
      className={cn(
        "flex shrink-0 h-6 items-center justify-between px-3 bg-muted border-b border-border text-app-ui-sm app-status-banner-text",
        variant === "error" && "bg-destructive/10 border-destructive/60 text-destructive",
        className,
      )}
    >
      <span className={dismiss ? "min-w-0 truncate" : undefined}>{message}</span>
      {actions.length > 0 || dismiss ? (
        <div className="flex shrink-0 items-center gap-2">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className="text-app-ui-sm app-status-banner-text hover:opacity-80 cursor-pointer bg-transparent border-0 p-0"
              onClick={action.onAction}
            >
              {action.label}
            </button>
          ))}
          {dismiss && <BannerDismissButton dismiss={dismiss} />}
        </div>
      ) : null}
    </div>
  );
}

export function Banner({ display = "inline", ...props }: BannerProps) {
  if (display === "bar") return <BarBanner {...props} />;
  return <InlineBanner {...props} />;
}
