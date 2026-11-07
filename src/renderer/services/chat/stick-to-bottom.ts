/**
 * Keeping a chat list at its bottom as it grows, until the user scrolls up.
 *
 * Scrolling to the bottom in code fires its scroll event a frame later. By
 * then more may have come in (a transcript loading, a streamed answer), and
 * the list reads as scrolled up, though the user never moved it. So a scroll
 * event at the position the code set is the code's own and leaves the list
 * stuck; any other position is the user's.
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
