/**
 * Dialog — shared modal shell for the Floating layer (design.md §2).
 *
 * Every modal in the app is a Floating-layer island: it sits above every
 * content island on a scrim, and so must use the Floating token set — NOT the
 * Island tokens (`bg-background` / `border-border`) the pre-Islands dialogs
 * borrowed. This shell is the single place that wiring lives:
 *
 *   - scrim    → --floating-scrim          (theme-switched modal backdrop)
 *   - surface  → bg-popover / popover-fg   (= surface.floating.bg / .fg)
 *   - border   → --surface-floating-border (Floating may carry an outline)
 *   - radius   → --radius-island           (Floating surfaces use island radius)
 *   - shadow   → none                      (no-shadow elevation, design.md §5)
 *
 * Routing every dialog through this shell makes those choices structurally
 * un-driftable: a call site cannot reintroduce `bg-black/40` or `shadow-lg`.
 *
 * The shell renders Radix `Root → Portal → Overlay → Content`. Callers own the
 * body, including the required `Dialog.Title` (Radix a11y contract).
 *
 * Radix AlertDialog-based modals cannot use the <Dialog> component (different
 * primitive) but MUST stay visually identical — they import DIALOG_OVERLAY_CLASS
 * and dialogContentClass() directly so the token set is shared.
 */

import { Dialog as RadixDialog } from "radix-ui";
import { useBrowserSuspendWhile } from "@/state/stores/browser-suspend";
import { cn } from "@/utils/cn";

/**
 * Dialog width steps. Centralising the three pixel widths here is what retires
 * the scattered `w-[420px]` / `w-[440px]` / `w-[480px]` / `w-[560px]` magic
 * numbers (design.md §12) — one source of truth, no drift.
 */
export type DialogSize = "sm" | "md" | "lg" | "xl";

const SIZE_CLASS: Record<DialogSize, string> = {
  sm: "w-[420px]", // single-line prompts, confirmations
  md: "w-[480px]", // multi-field forms
  lg: "w-[560px]", // multi-view / large-textarea dialogs
  xl: "w-[720px]", // split-pane dialogs (e.g. Settings nav 156 + form 544)
};

/**
 * Scrim + positioning for the Radix Overlay. Shared with AlertDialog modals.
 * The `dialog-overlay` class wires the fade in/out keyframes (globals.css).
 */
export const DIALOG_OVERLAY_CLASS = "dialog-overlay fixed inset-0 z-50 bg-[var(--floating-scrim)]";

/**
 * Floating-layer surface classes for a Radix Content node. The `dialog-content`
 * class wires the scale+fade in/out keyframes (globals.css).
 * @param padded - adds the standard 16px body inset; pass false for dialogs
 *                 that own their own header/footer chrome (e.g. AddWorkspace).
 */
export function dialogContentClass(size: DialogSize, padded: boolean, className?: string): string {
  return cn(
    "dialog-content fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 max-w-[90vw]",
    "rounded-(--radius-island) border border-[var(--surface-floating-border)]",
    "bg-popover text-popover-foreground outline-none",
    SIZE_CLASS[size],
    padded && "p-4",
    className,
  );
}

export interface DialogProps {
  /** Controlled open state. */
  open: boolean;
  /** Radix open-change contract — fires false on Esc / outside click / close. */
  onOpenChange: (open: boolean) => void;
  /** Width step. Default "md". */
  size?: DialogSize;
  /** Apply the standard 16px body inset. Default true. */
  padded?: boolean;
  /** Extra classes merged onto the Content node. */
  className?: string;
  /** Inline style for the Content node (e.g. min/max-height constraints). */
  contentStyle?: React.CSSProperties;
  /**
   * Forwarded to Radix Content. Names the dialog when the body uses a plain
   * heading element instead of a `RadixDialog.Title` (whose context wiring
   * would otherwise supply the accessible name automatically).
   */
  "aria-labelledby"?: string;
  /**
   * Forwarded to Radix Content. Pass `undefined` explicitly to opt out of the
   * description-id wiring when the dialog has no Dialog.Description.
   */
  "aria-describedby"?: string;
  /** Dialog body — must include a `RadixDialog.Title` for the a11y contract. */
  children: React.ReactNode;
}

/**
 * Floating-layer modal shell. Wraps Radix Dialog with the Islands Floating
 * token set; the caller supplies the body (Title, Description, content).
 */
export function Dialog({
  open,
  onOpenChange,
  size = "md",
  padded = true,
  className,
  contentStyle,
  children,
  ...rest
}: DialogProps): React.JSX.Element {
  // Suspend embedded browser views while the dialog is open so the modal's
  // scrim and content render above any WebContentsView overlay.  See
  // `state/stores/browser-suspend.ts` for the refcount details.
  useBrowserSuspendWhile(open);

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={DIALOG_OVERLAY_CLASS} />
        <RadixDialog.Content
          className={dialogContentClass(size, padded, className)}
          style={contentStyle}
          aria-labelledby={rest["aria-labelledby"]}
          aria-describedby={rest["aria-describedby"]}
        >
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
