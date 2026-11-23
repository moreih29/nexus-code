export type PaletteOpenMode = "default" | "side";

export interface PaletteAcceptModifiers {
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export interface PaletteAcceptContext {
  mode: PaletteOpenMode;
  modifiers?: PaletteAcceptModifiers;
  key?: string;
}

export interface PaletteItem {
  id: string;
  label: string;
  detail?: string;
  description?: string;
  kindLabel?: string;
  ariaLabel?: string;
  tooltip?: string;
  tone?: "destructive";
}

export interface PaletteSource<TItem extends PaletteItem = PaletteItem> {
  id: string;
  title: string;
  placeholder: string;
  emptyQueryMessage: string;
  noResultsMessage: string;
  maxQueryLength?: number;
  errorMessage?: (error: unknown) => string | undefined;
  searchOnEmptyQuery?: boolean;
  search(query: string, signal: AbortSignal): Promise<readonly TItem[]>;
  accept(item: TItem, context?: PaletteAcceptContext): void;
}
