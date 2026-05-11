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
 *
 * For menus that use React portals, use `useDismissOnOutsideClickMulti` so
 * that portal-mounted panels (which live outside the wrapper ref in the DOM)
 * are also treated as "inside" and do not incorrectly trigger a dismiss.
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

/**
 * useDismissOnOutsideClickMulti — like `useDismissOnOutsideClick` but accepts
 * an array of container refs so portal-mounted panels can be included in the
 * "inside" check.
 *
 * A `mousedown` is considered "inside" when the target is contained by **any**
 * of the supplied refs.  Pass the wrapper ref plus all portal panel refs to
 * prevent portal clicks from inadvertently closing the menu.
 */
export function useDismissOnOutsideClickMulti(
  containerRefs: ReadonlyArray<RefObject<HTMLElement | null>>,
  open: boolean,
  onDismiss: () => void,
): void {
  useEffect(() => {
    if (!open) return;

    function handleOutsidePointerDown(event: MouseEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      for (const ref of containerRefs) {
        if (ref.current?.contains(target)) return;
      }
      onDismiss();
    }

    document.addEventListener("mousedown", handleOutsidePointerDown);
    return () => {
      document.removeEventListener("mousedown", handleOutsidePointerDown);
    };
  }, [containerRefs, open, onDismiss]);
}

/**
 * useDismissOnOutsideClickWithMarker — like `useDismissOnOutsideClick` but
 * also treats clicks inside any element carrying the given `data-popover-root`
 * attribute value as "inside", enabling portal-mounted panels to participate
 * in outside-click containment without passing additional refs.
 *
 * Usage: attach `data-popover-root="<marker>"` to every portal panel element,
 * then pass the same string as `portalMarker` here.
 */
export function useDismissOnOutsideClickWithMarker(
  containerRef: RefObject<HTMLElement | null>,
  open: boolean,
  onDismiss: () => void,
  portalMarker: string,
): void {
  useEffect(() => {
    if (!open) return;

    function handleOutsidePointerDown(event: MouseEvent): void {
      const container = containerRef.current;
      if (!container) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (container.contains(target)) return;
      if (target.closest(`[data-popover-root="${portalMarker}"]`)) return;
      onDismiss();
    }

    document.addEventListener("mousedown", handleOutsidePointerDown);
    return () => {
      document.removeEventListener("mousedown", handleOutsidePointerDown);
    };
  }, [containerRef, open, onDismiss, portalMarker]);
}
