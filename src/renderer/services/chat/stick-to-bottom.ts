export const STICK_SLACK_PX = 48;

export interface ScrollView {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

export function nearBottom(view: ScrollView): boolean {
  return view.scrollHeight - view.scrollTop - view.clientHeight <= STICK_SLACK_PX;
}

export function isOwnScroll(view: ScrollView, ownTop: number | null): boolean {
  return ownTop !== null && Math.abs(view.scrollTop - ownTop) <= 1;
}

export function scrolledDown(view: ScrollView, lastTop: number): boolean {
  return view.scrollTop - lastTop > 1;
}
