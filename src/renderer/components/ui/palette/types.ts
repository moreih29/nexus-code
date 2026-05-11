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
  /**
   * When true, the controller invokes `search` for empty queries — including
   * the initial open — instead of short-circuiting to `idle`. The empty-query
   * path also bypasses the typing debounce so the picker shows results
   * immediately (matching VS Code's QuickPick behavior for branch / ref
   * pickers that pre-load an enumerable set).
   *
   * Defaults to false to preserve workspace-symbol "type-to-search" semantics.
   */
  searchOnEmptyQuery?: boolean;
  search(query: string, signal: AbortSignal): Promise<readonly TItem[]>;
  accept(item: TItem, context?: PaletteAcceptContext): void;
}
