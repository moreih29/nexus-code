/**
 * Defer an action raised from a Radix `ContextMenu.Item` until the
 * menu's `<FocusScope>` has released the caret.
 *
 * The problem: an `onSelect` handler that mounts a fresh focusable
 * element (e.g. an inline-edit input, a dialog) loses the focus race
 * to Radix's close animation — FocusScope is still active and pulls
 * focus back to the trigger when the menu unmounts. Calling
 * `e.preventDefault()` inside `onCloseAutoFocus` *and* mounting the
 * new element from there sidesteps both issues.
 *
 * Usage:
 *   const handoff = useContextMenuHandoff();
 *   <ContextMenuContent onCloseAutoFocus={handoff.onCloseAutoFocus}>
 *     <ContextMenuItem onSelect={() => handoff.defer(() => startInlineEdit())} />
 *   </ContextMenuContent>
 *
 * If no action was queued, `onCloseAutoFocus` is a no-op and Radix's
 * default trigger refocus runs — generic items keep their normal
 * focus-return behaviour.
 */

import { useCallback, useRef } from "react";

export interface ContextMenuHandoff {
  defer(action: () => void): void;
  onCloseAutoFocus(event: Event): void;
}

export function useContextMenuHandoff(): ContextMenuHandoff {
  const queuedRef = useRef<(() => void) | null>(null);

  const defer = useCallback((action: () => void) => {
    queuedRef.current = action;
  }, []);

  const onCloseAutoFocus = useCallback((event: Event) => {
    const action = queuedRef.current;
    if (!action) return;
    event.preventDefault();
    queuedRef.current = null;
    action();
  }, []);

  return { defer, onCloseAutoFocus };
}
