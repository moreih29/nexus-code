export type PaletteOpenMode = "default" | "side";

export interface PaletteAcceptContext {
  mode: PaletteOpenMode;
}

export interface PaletteItem {
  id: string;
  label: string;
  detail?: string;
  description?: string;
  kindLabel?: string;
  ariaLabel?: string;
  tooltip?: string;
}

export interface PaletteSource<TItem extends PaletteItem = PaletteItem> {
  id: string;
  title: string;
  placeholder: string;
  emptyQueryMessage: string;
  noResultsMessage: string;
  search(query: string, signal: AbortSignal): Promise<readonly TItem[]>;
  accept(item: TItem, context: PaletteAcceptContext): void;
}
