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
 *
 * A focus comes late at times: that frame is long when a terminal first
 * shows, a view mounts, a terminal opens only once its fonts load. It must
 * not cut short what the user started typing meanwhile. Starting to edit a
 * tab's name drops every focus not yet given (cancelTabFocus), and one that
 * waited is dropped too once the user has gone into a text field since it
 * was asked for. A view's focus function is handed the test, for a focus it
 * must put off itself (a terminal not open yet).
 */

/** Focuses a tab's content; `wanted` tells, when it must wait, whether it still should. */
export type TabFocusTarget = (wanted: () => boolean) => void;

const targets = new Map<string, TabFocusTarget>();
let pending: { tabId: string; wanted: () => boolean } | null = null;
/** Counts requests and cancels: a focus is given only while none came after it. */
let generation = 0;

/** Inputs that take no typing: a focus may still move on from them. */
const NON_TEXT_INPUTS = new Set([
  "button",
  "checkbox",
  "radio",
  "range",
  "color",
  "file",
  "submit",
  "reset",
]);

function isTextField(el: Element): boolean {
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName === "INPUT") return !NON_TEXT_INPUTS.has((el as HTMLInputElement).type);
  return (el as HTMLElement).isContentEditable === true;
}

function focusedElement(): Element | null {
  return globalThis.document?.activeElement ?? null;
}

/**
 * Whether a focus asked for while `from` had it still applies after waiting:
 * not when the user has put the focus in a text field since, where it would
 * cut short what they are typing.
 */
export function focusStillWanted(from: Element | null): boolean {
  const now = focusedElement();
  if (!now || now === from || now === globalThis.document?.body) return true;
  return !isTextField(now);
}

/**
 * Registers `focus` as the way to focus tab `tabId`'s content. Returns an
 * unregister function for the view's unmount.
 */
export function registerTabFocusTarget(tabId: string, focus: TabFocusTarget): () => void {
  targets.set(tabId, focus);
  if (pending?.tabId === tabId) {
    const { wanted } = pending;
    pending = null;
    requestAnimationFrame(() => {
      if (wanted()) focus(wanted);
    });
  }
  return () => {
    if (targets.get(tabId) === focus) targets.delete(tabId);
  };
}

/** Focuses tab `tabId`'s content, now or once its view registers. */
export function requestTabFocus(tabId: string): void {
  const asked = ++generation;
  const from = focusedElement();
  const current = () => asked === generation;
  const wanted = () => current() && focusStillWanted(from);
  const focus = targets.get(tabId);
  if (!focus) {
    pending = { tabId, wanted };
    return;
  }
  pending = null;
  // Not tested for typing elsewhere: within the frame the focus has only
  // moved as the switch moved it (a closing menu or palette handing it back).
  requestAnimationFrame(() => {
    if (current()) focus(wanted);
  });
}

/** Drops every focus asked for and not yet given: the user is about to type (a tab's name). */
export function cancelTabFocus(): void {
  generation += 1;
  pending = null;
}
