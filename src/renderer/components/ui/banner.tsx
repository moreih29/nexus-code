/**
 * Banner — unified surface-level notice primitive (design.md §7 feedback states).
 *
 * Two display modes:
 *   "inline" — padded box inside a panel; variable height; used for operation notices.
 *   "bar"    — h-6 full-width status bar above editor/workspace; fixed height.
 *
 * Variant drives icon + destructive styling; the almost-monochromatic mission
 * means info/warning/success all render with the same muted chrome — only
 * "error" carries a distinct destructive color signal.
 */
import { CheckCircle2, CircleAlert, Info } from "lucide-react";
import { cn } from "@/utils/cn";
import { Button } from "./button";

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
  role?: "status" | "alert";
  "aria-live"?: "polite" | "assertive" | "off";
  className?: string;
}

/**
 * Returns the Tailwind class tuple for a given variant's color treatment.
 * Exported so specialized banners (OperationBanner) can share the same color
 * logic without duplicating the class strings.
 */
export function bannerColorClass(variant: BannerVariant): string {
  if (variant === "error") return "border-destructive/60 bg-destructive/10 git-destructive-text";
  return "border-border bg-muted text-foreground";
}

function BannerIcon({ variant, className }: { variant: BannerVariant; className?: string }) {
  if (variant === "success") return <CheckCircle2 className={className} aria-hidden="true" />;
  if (variant === "error" || variant === "warning")
    return <CircleAlert className={className} aria-hidden="true" />;
  return <Info className={className} aria-hidden="true" />;
}

/**
 * Inline display — padded notice box inside a panel scroll area.
 * Geometry: mx-2 my-1, rounded-[--radius-container], border, variable height.
 */
function InlineBanner({
  variant = "info",
  message,
  details,
  actions = [],
  role,
  "aria-live": ariaLive,
  className,
}: BannerProps) {
  return (
    <div
      className={cn(
        "mx-2 my-1 flex items-start gap-2 rounded-[--radius-container] border px-2 py-2 text-app-ui-sm",
        bannerColorClass(variant),
        className,
      )}
      role={role ?? (variant === "error" ? "alert" : "status")}
      aria-live={ariaLive}
    >
      <BannerIcon variant={variant} className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="whitespace-pre-wrap break-words text-foreground">{message}</p>
        {details ? (
          <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{details}</p>
        ) : null}
      </div>
      {actions.length > 0 ? (
        <div className="flex shrink-0 items-center gap-1">
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

/**
 * Bar display — fixed h-6 full-width status strip, border-b, horizontal layout.
 * Geometry mirrors ReadOnlyBanner / ConflictResolvedBanner / TerminalStatusBanner.
 */
function BarBanner({
  variant = "info",
  message,
  actions = [],
  role,
  "aria-live": ariaLive,
  className,
}: BannerProps) {
  return (
    <div
      role={role ?? (variant === "error" ? "alert" : "status")}
      aria-live={ariaLive}
      className={cn(
        "flex shrink-0 h-6 items-center justify-between px-3 bg-muted border-b border-border text-app-ui-xs app-status-banner-text",
        variant === "error" && "bg-destructive/10 border-destructive/60 text-destructive",
        className,
      )}
    >
      <span>{message}</span>
      {actions.length > 0 ? (
        <div className="flex items-center gap-2">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className="text-app-ui-xs app-status-banner-text hover:opacity-80 cursor-pointer bg-transparent border-0 p-0"
              onClick={action.onAction}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Banner — routes to InlineBanner or BarBanner based on display prop.
 */
export function Banner({ display = "inline", ...props }: BannerProps) {
  if (display === "bar") return <BarBanner {...props} />;
  return <InlineBanner {...props} />;
}
