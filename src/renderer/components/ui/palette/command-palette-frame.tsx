import { useTranslation } from "react-i18next";
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
  footer?: React.ReactNode;
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
  footer,
}: CommandPaletteFrameProps<TItem>): React.JSX.Element | null {
  const { t } = useTranslation();
  if (status === "closed") return null;

  const activeItem = activeIndex >= 0 ? items[activeIndex] : undefined;
  const activeDescendant = activeItem ? optionId(listboxId, activeItem.id) : undefined;

  return (
    <div className="fixed inset-0 z-[70] bg-[var(--floating-scrim)]">
      <button
        type="button"
        aria-label={t("palette.close_aria")}
        tabIndex={-1}
        className="absolute inset-0 h-full w-full cursor-default bg-transparent"
        // Outside-click dismissal: the overlay button fills the viewport
        // behind the dialog content, so pressing it means the user clicked
        // outside the palette and expects it to close.
        onMouseDown={(event) => {
          event.preventDefault();
          onOverlayClick?.();
        }}
      />
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-command-palette-root="true"
        onKeyDown={onKeyDown}
        className="pointer-events-auto fixed left-1/2 top-[18vh] z-[1] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 floating-panel"
      >
        <h2 id={titleId} className="sr-only">
          {title}
        </h2>
        <div className="border-b border-border/70 px-3 py-2">
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
                const destructive = item.tone === "destructive";
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
                      "grid min-h-[52px] cursor-default grid-cols-[1fr_auto] gap-x-3 rounded-(--radius-control) px-3 py-2 text-app-ui-sm",
                      selected
                        ? destructive
                          ? "bg-destructive/10"
                          : "bg-[var(--state-hover-bg)]"
                        : "bg-transparent",
                    )}
                  >
                    <div className="min-w-0">
                      <div
                        className={cn(
                          "truncate",
                          destructive ? "git-destructive-text" : "text-warm-parchment",
                        )}
                      >
                        {item.label}
                      </div>
                      <div className="truncate text-stone-gray">
                        {item.detail ?? item.description}
                      </div>
                    </div>
                    {item.kindLabel ? (
                      <div
                        className={cn(
                          "self-start text-app-label uppercase",
                          destructive ? "git-destructive-text" : "text-stone-gray",
                        )}
                      >
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
              query={query}
              emptyQueryMessage={emptyQueryMessage}
              noResultsMessage={noResultsMessage}
            />
          )}
        </div>
        {footer ? (
          <div className="border-t border-border/70 px-3 py-2 text-app-ui-sm text-stone-gray">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PaletteStatusMessage({
  status,
  query,
  emptyQueryMessage,
  noResultsMessage,
}: {
  status: Exclude<PaletteViewStatus, "closed" | "results">;
  query: string;
  emptyQueryMessage: string;
  noResultsMessage: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const message = (() => {
    switch (status) {
      case "no-workspace":
        return t("palette.no_workspace");
      case "idle":
        return emptyQueryMessage;
      case "debouncing":
        return t("palette.waiting_input");
      case "loading":
        return query.trim().length === 0 ? emptyQueryMessage : t("palette.searching");
      case "empty":
        return noResultsMessage;
      case "error":
        return t("palette.search_failed");
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
