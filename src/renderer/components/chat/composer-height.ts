// How tall the composer's text box may grow before it scrolls: 240px, or in
// a tall tab up to 30% of the column the composer sits in.

/** The cap in any tab, however short. */
export const MAX_TEXT_PX = 240;
/** How much of a tall tab's column the text box may take. */
export const MAX_TEXT_SHARE = 0.3;

/** The text box's cap in a column `columnHeight` pixels tall. */
export function maxTextHeight(columnHeight: number): number {
  return Math.max(MAX_TEXT_PX, Math.floor(columnHeight * MAX_TEXT_SHARE));
}

// Textarea height follows the wrapped text and the height of its chat column.
export function fitTextHeight(
  area: HTMLTextAreaElement,
  column: HTMLElement | null | undefined,
): void {
  // A parked tab is fitted when it is shown.
  if (area.offsetWidth === 0 || area.closest("[inert]")) return;

  // While measuring, a vertical scrollbar would narrow the text and change
  // how many lines fit. Let it appear again if the final height is capped.
  const overflowY = area.style.overflowY;
  area.style.overflowY = "hidden";
  area.style.height = "auto";
  const cap = maxTextHeight(column?.clientHeight ?? 0);
  const height = Math.min(area.scrollHeight, cap);
  area.style.height = `${height}px`;
  area.style.overflowY = overflowY;

  // Restoring overflow can wrap another line on a classic scrollbar.
  // Give that line room too, as long as the cap allows it.
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
    // A scrollbar changes clientWidth even if the textarea itself did not resize.
    const nextWidth = area.offsetWidth;
    const nextHeight = column?.clientHeight ?? 0;
    if (nextWidth === width && nextHeight === height) return;
    width = nextWidth;
    height = nextHeight;

    // Changing the observed element's height during delivery can leave a
    // ResizeObserver notification undelivered. Apply the fit on the next frame.
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
