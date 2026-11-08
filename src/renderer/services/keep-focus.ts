/**
 * Gives keyboard focus back to what held it when a change to the layout
 * dropped it.
 *
 * Splitting a group rebuilds the group's slot, and the content it shows (a
 * terminal, a chat's composer) is detached on its way to the new slot. That
 * takes the focus from it without giving it to anything else: it falls to
 * <body>, and what the user types goes nowhere. Once the content is back in
 * the document, the element it fell from gets it back, unless something
 * else has taken it meanwhile (a dialog, a tab the change meant to focus).
 */

/** The parts of a focusable element this needs. */
export interface FocusHolder {
  readonly isConnected: boolean;
  focus(options?: FocusOptions): void;
  closest(selector: string): unknown;
}

/** The parts of the document this needs. */
export interface FocusDocument {
  readonly activeElement: unknown;
  readonly body: unknown;
}

/**
 * How many frames after a change its content may take to be back in the
 * document: React renders the new layout, then moves the content into its
 * slot in an effect.
 */
export const SETTLE_FRAMES = 10;

/** What holds the keyboard now; null when nothing does. */
export function focusHolder(doc: FocusDocument = document): FocusHolder | null {
  const active = doc.activeElement;
  if (active === null || active === doc.body) return null;
  return active as FocusHolder;
}

/**
 * Over the next `frames` frames, focuses `held` again whenever the focus has
 * fallen to <body> and it is back in the document. Stops as soon as anything
 * else holds the focus.
 */
export function restoreFocus(
  held: FocusHolder | null,
  doc: FocusDocument = document,
  frames: number = SETTLE_FRAMES,
  nextFrame: (run: () => void) => void = (run) => requestAnimationFrame(run),
): void {
  if (held === null) return;
  const check = (left: number) => {
    const active = doc.activeElement;
    const dropped = active === null || active === doc.body;
    if (!dropped && active !== held) return;
    // A parked view is inert: focusing into it does nothing.
    if (dropped && held.isConnected && !held.closest("[inert]")) {
      held.focus({ preventScroll: true });
    }
    if (left > 1) nextFrame(() => check(left - 1));
  };
  nextFrame(() => check(frames));
}
