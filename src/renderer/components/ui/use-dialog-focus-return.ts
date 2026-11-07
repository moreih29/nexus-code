/**
 * Puts the keyboard back where it was when a dialog opened, once it closes.
 *
 * Radix returns it only to the dialog's own Trigger. Every dialog here is
 * opened from code instead — a menu item, a shortcut, a button that sets
 * state — so it has none, and closing one left the keyboard on the page.
 *
 * Usage: pass `open`, and the result as Content's `onCloseAutoFocus`.
 * Where the keyboard was is read before the dialog's content mounts (a
 * layout effect, ahead of the portal), so an autoFocus field inside cannot
 * have taken it yet. Closing hands it back only when nothing else took it:
 * a confirm that opened an editor leaves the keyboard in the editor.
 */
import { useCallback, useLayoutEffect, useRef } from "react";

export function useDialogFocusReturn(open: boolean): (event: Event) => void {
  const returnTo = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const focused = document.activeElement;
    returnTo.current = focused instanceof HTMLElement && focused !== document.body ? focused : null;
  }, [open]);

  return useCallback((event: Event) => {
    event.preventDefault();
    const target = returnTo.current;
    returnTo.current = null;
    const focused = document.activeElement;
    if (focused && focused !== document.body) return;
    if (target?.isConnected) target.focus({ preventScroll: true });
  }, []);
}
