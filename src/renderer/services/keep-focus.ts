export interface FocusHolder {
  readonly isConnected: boolean;
  focus(options?: FocusOptions): void;
  closest(selector: string): unknown;
}

export interface FocusDocument {
  readonly activeElement: unknown;
  readonly body: unknown;
}

export const SETTLE_FRAMES = 10;

export function focusHolder(doc: FocusDocument = document): FocusHolder | null {
  const active = doc.activeElement;
  if (active === null || active === doc.body) return null;
  return active as FocusHolder;
}

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
    if (dropped && held.isConnected && !held.closest("[inert]")) {
      held.focus({ preventScroll: true });
    }
    if (left > 1) nextFrame(() => check(left - 1));
  };
  nextFrame(() => check(frames));
}
