/**
 * Moves keyboard focus into a tab's content after the user opens or switches
 * to it, so typing lands in the terminal or editor instead of staying on the
 * control that triggered the switch (the `+` menu, a tab header) or on
 * <body> (a keyboard shortcut).
 *
 * Views register a focus function per tab while they are mounted. A request
 * for a tab whose view has not registered yet — a terminal or editor that is
 * still mounting — is kept until it does. Only the latest request is kept:
 * once the user moves on to another tab, the earlier one no longer matters.
 *
 * Focus is applied on the next animation frame. Activating a tab moves its
 * content out of the view park in an effect, and a parked element is
 * `visibility:hidden`, which silently refuses focus.
 */

const targets = new Map<string, () => void>();
let pendingTabId: string | null = null;

function focusNextFrame(focus: () => void): void {
  requestAnimationFrame(() => focus());
}

/**
 * Registers `focus` as the way to focus tab `tabId`'s content. Returns an
 * unregister function for the view's unmount.
 */
export function registerTabFocusTarget(tabId: string, focus: () => void): () => void {
  targets.set(tabId, focus);
  if (pendingTabId === tabId) {
    pendingTabId = null;
    focusNextFrame(focus);
  }
  return () => {
    if (targets.get(tabId) === focus) targets.delete(tabId);
  };
}

/** Focuses tab `tabId`'s content, now or once its view registers. */
export function requestTabFocus(tabId: string): void {
  const focus = targets.get(tabId);
  if (!focus) {
    pendingTabId = tabId;
    return;
  }
  pendingTabId = null;
  focusNextFrame(focus);
}

export function __resetTabFocusForTests(): void {
  targets.clear();
  pendingTabId = null;
}
