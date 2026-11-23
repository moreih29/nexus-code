export const MAX_TEXT_PX = 240;
export const MAX_TEXT_SHARE = 0.3;

export function maxTextHeight(columnHeight: number): number {
  return Math.max(MAX_TEXT_PX, Math.floor(columnHeight * MAX_TEXT_SHARE));
}

export function fitTextHeight(
  area: HTMLTextAreaElement,
  column: HTMLElement | null | undefined,
): void {
  if (area.offsetWidth === 0 || area.closest("[inert]")) return;

  const overflowY = area.style.overflowY;
  area.style.overflowY = "hidden";
  area.style.height = "auto";
  const cap = maxTextHeight(column?.clientHeight ?? 0);
  const height = Math.min(area.scrollHeight, cap);
  area.style.height = `${height}px`;
  area.style.overflowY = overflowY;

  if (height < cap) {
    const restoredHeight = Math.min(area.scrollHeight, cap);
    if (restoredHeight > height) area.style.height = `${restoredHeight}px`;
  }
}

export function observeTextHeight(
  area: HTMLTextAreaElement,
  column: HTMLElement | null | undefined,
): () => void {
  let width = area.offsetWidth;
  let height = column?.clientHeight ?? 0;
  let frame: number | undefined;
  const observer = new ResizeObserver(() => {
    const nextWidth = area.offsetWidth;
    const nextHeight = column?.clientHeight ?? 0;
    if (nextWidth === width && nextHeight === height) return;
    width = nextWidth;
    height = nextHeight;

    if (frame === undefined) {
      frame = requestAnimationFrame(() => {
        frame = undefined;
        fitTextHeight(area, column);
      });
    }
  });
  observer.observe(area, { box: "border-box" });
  if (column) observer.observe(column);
  return () => {
    observer.disconnect();
    if (frame !== undefined) cancelAnimationFrame(frame);
  };
}
