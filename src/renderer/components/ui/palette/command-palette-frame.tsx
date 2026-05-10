import { cn } from "../../../utils/cn";
import type { PaletteViewStatus } from "./controller";
import type { PaletteItem } from "./types";

export interface CommandPaletteFrameProps<TItem extends PaletteItem> {
  status: PaletteViewStatus;
  title: string;
  placeholder: string;
  query: string;
  items: readonly TItem[];
  activeIndex: number;
  dimmed?: boolean;
  emptyQueryMessage: string;
  noResultsMessage: string;
  onQueryChange?: (query: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  /**
   * Fires when the user clicks the modal overlay (the dimmed area outside
   * the dialog content). Used to dismiss the palette on outside click.
   */
  onOverlayClick?: () => void;
  onHoverItem?: (index: number) => void;
  onAcceptItem?: (index: number) => void;
  rootRef?: React.Ref<HTMLDivElement>;
  inputRef?: React.Ref<HTMLInputElement>;
  titleId?: string;
  inputId?: string;
  listboxId?: string;
}

export function CommandPaletteFrame<TItem extends PaletteItem>({
  status,
  title,
  placeholder,
  query,
  items,
  activeIndex,
  dimmed = false,
  emptyQueryMessage,
  noResultsMessage,
  onQueryChange,
  onKeyDown,
  onOverlayClick,
  onHoverItem,
  onAcceptItem,
  rootRef,
  inputRef,
  titleId = "command-palette-title",
  inputId = "command-palette-input",
  listboxId = "command-palette-listbox",
}: CommandPaletteFrameProps<TItem>): React.JSX.Element | null {
  if (status === "closed") return null;

  const activeItem = activeIndex >= 0 ? items[activeIndex] : undefined;
  const activeDescendant = activeItem ? optionId(listboxId, activeItem.id) : undefined;

  return (
    <div
      className="fixed inset-0 z-[70] bg-frosted-veil-strong"
      // Outside-click dismissal: the overlay div fills the viewport behind
      // the dialog content. A click whose target is exactly this element
      // (not the bubbled child dialog) means the user pressed outside the
      // palette and expects it to close, matching Radix Dialog behavior.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onOverlayClick?.();
        }
      }}
    >
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-command-palette-root="true"
        onKeyDown={onKeyDown}
        className="pointer-events-auto fixed left-1/2 top-[18vh] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 rounded-[12px] border border-mist-border bg-popover text-popover-foreground shadow-none"
      >
        <h2 id={titleId} className="sr-only">
          {title}
        </h2>
        <div className="border-b border-mist-border/70 px-3 py-2">
          <input
            ref={inputRef}
            id={inputId}
            value={query}
            onChange={(event) => onQueryChange?.(event.target.value)}
            role="combobox"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-activedescendant={activeDescendant}
            aria-autocomplete="list"
            aria-label={title}
            placeholder={placeholder}
            className="h-9 w-full bg-transparent text-app-body-emphasis text-warm-parchment outline-none placeholder:text-stone-gray"
          />
        </div>
        <div
          className={cn(
            "max-h-[360px] overflow-y-auto p-1 transition-opacity duration-150",
            dimmed ? "opacity-50 pointer-events-none" : "opacity-100",
          )}
          aria-busy={dimmed ? true : undefined}
        >
          {status === "results" ? (
            <div id={listboxId} role="listbox" aria-label={title} className="space-y-0.5">
              {items.map((item, index) => {
                const selected = index === activeIndex;
                return (
                  <div
                    key={item.id}
                    id={optionId(listboxId, item.id)}
                    role="option"
                    aria-selected={selected}
                    aria-label={item.ariaLabel ?? item.label}
                    onMouseEnter={() => onHoverItem?.(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onAcceptItem?.(index)}
                    title={item.tooltip}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      onAcceptItem?.(index);
                    }}
                    tabIndex={selected ? 0 : -1}
                    className={cn(
                      "grid min-h-[52px] cursor-default grid-cols-[1fr_auto] gap-x-3 rounded-[6px] px-3 py-2 text-app-ui-sm",
                      selected ? "bg-frosted-veil" : "bg-transparent",
                    )}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-warm-parchment">{item.label}</div>
                      <div className="truncate text-stone-gray">
                        {item.detail ?? item.description}
                      </div>
                    </div>
                    {item.kindLabel ? (
                      <div className="self-start text-app-ui-xs uppercase tracking-[1.4px] text-stone-gray">
                        {item.kindLabel}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <PaletteStatusMessage
              status={status as Exclude<PaletteViewStatus, "closed" | "results">}
              emptyQueryMessage={emptyQueryMessage}
              noResultsMessage={noResultsMessage}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function PaletteStatusMessage({
  status,
  emptyQueryMessage,
  noResultsMessage,
}: {
  status: Exclude<PaletteViewStatus, "closed" | "results">;
  emptyQueryMessage: string;
  noResultsMessage: string;
}): React.JSX.Element {
  const message = (() => {
    switch (status) {
      case "no-workspace":
        return "Open a workspace to search symbols.";
      case "idle":
        return emptyQueryMessage;
      case "debouncing":
        return "Waiting for input…";
      case "loading":
        return "Searching…";
      case "empty":
        return noResultsMessage;
      case "error":
        return "Workspace symbol search failed.";
    }
  })();

  return (
    <div role="status" className="px-3 py-8 text-center text-app-ui-sm text-stone-gray">
      {message}
    </div>
  );
}

function optionId(listboxId: string, itemId: string): string {
  return `${listboxId}-option-${itemId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}
