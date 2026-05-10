/**
 * useDismissOnOutsideClick — close a popover/menu when the user clicks
 * anywhere outside its container.
 *
 * Pairs with the project's house pattern of building popovers as a relative
 * wrapper around a trigger button + panel `<div>`. Pass the wrapper ref and
 * the open state; the hook attaches a `mousedown` listener at document level
 * while open, and invokes `onDismiss` for clicks whose target is not inside
 * the wrapper.
 *
 * Why `mousedown` (not `click`): firing on press matches native menu UX —
 * the popover is gone before the click bubbles to whatever the user was
 * about to interact with, so a single click both dismisses the popover and
 * activates the new target. Using `click` instead causes the second target
 * to need two clicks (one to dismiss, one to activate).
 */

import { type RefObject, useEffect } from "react";

export function useDismissOnOutsideClick(
  containerRef: RefObject<HTMLElement | null>,
  open: boolean,
  onDismiss: () => void,
): void {
  useEffect(() => {
    if (!open) return;

    function handleOutsidePointerDown(event: MouseEvent): void {
      const container = containerRef.current;
      if (!container) return;
      const target = event.target;
      if (target instanceof Node && container.contains(target)) return;
      onDismiss();
    }

    document.addEventListener("mousedown", handleOutsidePointerDown);
    return () => {
      document.removeEventListener("mousedown", handleOutsidePointerDown);
    };
  }, [containerRef, open, onDismiss]);
}
