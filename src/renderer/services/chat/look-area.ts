export const LOOK_AREA_ATTR = "data-look-area";

export function lookAreaOf(el: Pick<Element, "closest"> | null): HTMLElement | null {
  return el?.closest<HTMLElement>(`[${LOOK_AREA_ATTR}]`) ?? null;
}
