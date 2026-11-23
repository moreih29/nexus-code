export const FIELD_PADDING_PX = 16;
export const FIELD_BORDER_PX = 1;
export const FIELD_CHROME_PX = FIELD_PADDING_PX + FIELD_BORDER_PX;
export const GUTTER_PADDING_PX = 8;

export function gutterTrack(rowCount: number): string {
  const digits = Math.max(2, String(rowCount).length);
  return `calc(${digits}ch + ${GUTTER_PADDING_PX}px)`;
}

export function fieldTrack(chars: number): string {
  return `calc(${chars}ch + ${FIELD_CHROME_PX}px)`;
}

export function gridTemplate(rowCount: number, widths: readonly number[]): string {
  return [gutterTrack(rowCount), ...widths.map(fieldTrack)].join(" ");
}
