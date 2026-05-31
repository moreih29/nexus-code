/**
 * ErrorNotice — the add-workspace flow's inline error box.
 *
 * Centralizes the `--state-error-*` token treatment + AlertCircle icon + the
 * `role="alert"` structure that was previously copy-pasted across the four
 * add-workspace views. Distinct from the global `ui/banner` primitive on
 * purpose: that one uses `destructive/*` tokens and a different icon, so this
 * flow keeps its own (subtle neutral-bg) error chrome unchanged.
 *
 * Per-site differences in the historical markup (padding, icon size, text
 * scale, optional action row) are preserved via props rather than unified, so
 * extraction is pixel-for-pixel.
 */
import { AlertCircle } from "lucide-react";
import { cn } from "@/utils/cn";

const NOTICE_BOX =
  "rounded-(--radius-control) border border-[var(--state-error-border)] bg-[var(--state-error-bg)]";

export interface ErrorNoticeProps {
  readonly message: string;
  /** Extra classes on the outer box — padding plus per-site layout (w-full / shrink-0 / mx-2 mb-1). */
  readonly className?: string;
  /** Icon size — "md" (size-4) matches the main-list banner; default "sm" (size-3.5). */
  readonly iconSize?: "sm" | "md";
  /** Message text scale — defaults to text-app-ui-sm; the connection list uses text-app-micro. */
  readonly textClass?: string;
  /** Optional action row rendered below the message (e.g. an "Open settings" link button). */
  readonly children?: React.ReactNode;
}

export function ErrorNotice({
  message,
  className,
  iconSize = "sm",
  textClass = "text-app-ui-sm",
  children,
}: ErrorNoticeProps): React.JSX.Element {
  const content = (
    <>
      <AlertCircle
        className={cn(
          "mt-0.5 shrink-0 text-[var(--state-error-fg)]",
          iconSize === "md" ? "size-4" : "size-3.5",
        )}
        aria-hidden="true"
      />
      <span className={cn("min-w-0 text-[var(--state-error-fg)]", textClass)}>{message}</span>
    </>
  );

  // With an action row the box is a flex column (icon+text row, then children);
  // without one the box IS the row — preserving the two historical structures.
  if (children) {
    return (
      <div className={cn("flex flex-col gap-2", NOTICE_BOX, className)} role="alert">
        <div className="flex items-start gap-2">{content}</div>
        {children}
      </div>
    );
  }
  return (
    <div className={cn("flex items-start gap-2", NOTICE_BOX, className)} role="alert">
      {content}
    </div>
  );
}
