import { useEffect, useId, useRef, useState } from "react";
import { cn } from "../../../utils/cn";
import {
  initialPaletteSearchSnapshot,
  PaletteSearchController,
  type PaletteSearchSnapshot,
  type PaletteViewStatus,
  resolvePaletteKeyAction,
} from "./controller";
import type { PaletteItem, PaletteSource } from "./types";

interface CommandPaletteProps<TItem extends PaletteItem> {
  open: boolean;
  source: PaletteSource<TItem> | null;
  onClose: () => void;
}

export function CommandPalette<TItem extends PaletteItem>({
  open,
  source,
  onClose,
}: CommandPaletteProps<TItem>): React.JSX.Element | null {
  const [query, setQuery] = useState("");
  const [snapshot, setSnapshot] = useState<PaletteSearchSnapshot<TItem>>(() =>
    initialPaletteSearchSnapshot(),
  );
  const queryRef = useRef(query);
  const controllerRef = useRef<PaletteSearchController<TItem> | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const inputId = useId();
  const listboxId = useId();
  queryRef.current = query;

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSnapshot(initialPaletteSearchSnapshot());
  }, [open]);

  useEffect(() => {
    controllerRef.current?.dispose();
    controllerRef.current = null;

    if (!open || !source) return;
    const controller = new PaletteSearchController(source, setSnapshot);
    controllerRef.current = controller;
    controller.setQuery(queryRef.current);
    return () => {
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [open, source]);

  useEffect(() => {
    if (!open || !source) return;
    controllerRef.current?.setQuery(query);
  }, [open, source, query]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    previouslyFocusedRef.current = previouslyFocused;
    inputRef.current?.focus();
    return () => {
      const target = previouslyFocusedRef.current;
      previouslyFocusedRef.current = null;
      if (target?.isConnected && !target.hasAttribute("disabled")) {
        target.focus({ preventScroll: true });
      }
    };
  }, [open]);

  if (!open) return null;

  const status: PaletteViewStatus = source ? snapshot.status : "no-workspace";

  function accept(mode: "default" | "side"): void {
    if (!source || snapshot.activeIndex < 0) return;
    const item = snapshot.items[snapshot.activeIndex];
    if (!item) return;
    onClose();
    source.accept(item, { mode });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    const action = resolvePaletteKeyAction(
      { key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey },
      snapshot.activeIndex,
      snapshot.items.length,
    );

    if (action.kind === "none") return;
    e.preventDefault();

    if (action.kind === "move") {
      setSnapshot((current) => ({ ...current, activeIndex: action.activeIndex }));
    } else if (action.kind === "accept") {
      accept(action.mode);
    } else if (action.kind === "close") {
      onClose();
    } else if (action.kind === "trap-tab") {
      trapTab(rootRef.current, e.shiftKey);
    }
  }

  return (
    <CommandPaletteFrame
      rootRef={rootRef}
      inputRef={inputRef}
      titleId={titleId}
      inputId={inputId}
      listboxId={listboxId}
      status={status}
      title={source?.title ?? "Go to Symbol in Workspace"}
      placeholder={source?.placeholder ?? "Search workspace symbols"}
      query={query}
      items={snapshot.items}
      activeIndex={snapshot.activeIndex}
      emptyQueryMessage={source?.emptyQueryMessage ?? "Open a workspace to search symbols."}
      noResultsMessage={source?.noResultsMessage ?? "No workspace symbols found."}
      onQueryChange={setQuery}
      onKeyDown={handleKeyDown}
      onHoverItem={(index) => setSnapshot((current) => ({ ...current, activeIndex: index }))}
      onAcceptItem={(index) => {
        setSnapshot((current) => ({ ...current, activeIndex: index }));
        if (!source) return;
        const item = snapshot.items[index];
        if (!item) return;
        onClose();
        source.accept(item, { mode: "default" });
      }}
    />
  );
}

interface CommandPaletteFrameProps<TItem extends PaletteItem> {
  status: PaletteViewStatus;
  title: string;
  placeholder: string;
  query: string;
  items: readonly TItem[];
  activeIndex: number;
  emptyQueryMessage: string;
  noResultsMessage: string;
  onQueryChange?: (query: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
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
  emptyQueryMessage,
  noResultsMessage,
  onQueryChange,
  onKeyDown,
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
    <div className="fixed inset-0 z-[70] bg-frosted-veil-strong">
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
        <div className="max-h-[360px] overflow-y-auto p-1">
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

function trapTab(root: HTMLElement | null, backwards: boolean): void {
  if (!root) return;
  const focusable = [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true",
  );
  if (focusable.length === 0) return;

  const active = document.activeElement as HTMLElement | null;
  const currentIndex = active ? focusable.indexOf(active) : -1;
  const nextIndex = backwards
    ? currentIndex <= 0
      ? focusable.length - 1
      : currentIndex - 1
    : currentIndex >= focusable.length - 1
      ? 0
      : currentIndex + 1;
  focusable[nextIndex]?.focus();
}

const FOCUSABLE_SELECTOR = [
  "button",
  "[href]",
  "input",
  "select",
  "textarea",
  '[tabindex]:not([tabindex="-1"])',
].join(",");
