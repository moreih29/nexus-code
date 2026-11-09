/**
 * Keeping a chat list at its bottom as it grows, until the user scrolls up.
 *
 * Scrolling to the bottom in code fires its scroll event a frame later. By
 * then more may have come in (a transcript loading, a streamed answer), and
 * the list reads as scrolled up, though the user never moved it. So a scroll
 * event at the position the code set is the code's own and leaves the list
 * stuck; any other position is the user's.
 *
 * The page moves the list too: the view grows and the browser cuts the
 * scroll short, then gives it back as a scroll down when the view gets
 * shorter again (a permission request docked under it), before it is told
 * of the new size. The user leaves the bottom only by scrolling up, so a
 * scroll down keeps a stuck list stuck.
 */

/** How near the bottom (px) still counts as being there. */
export const STICK_SLACK_PX = 48;

export interface ScrollView {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** Whether the list is at its bottom, give or take {@link STICK_SLACK_PX}. */
export function nearBottom(view: ScrollView): boolean {
  return view.scrollHeight - view.scrollTop - view.clientHeight <= STICK_SLACK_PX;
}

/** Whether a scroll event is the code's own scroll to `ownTop`. */
export function isOwnScroll(view: ScrollView, ownTop: number | null): boolean {
  // Subpixel scroll positions round on the way back.
  return ownTop !== null && Math.abs(view.scrollTop - ownTop) <= 1;
}

/** Whether the list moved down since `lastTop`, where it last was. */
export function scrolledDown(view: ScrollView, lastTop: number): boolean {
  // Subpixel scroll positions round on the way back.
  return view.scrollTop - lastTop > 1;
}
