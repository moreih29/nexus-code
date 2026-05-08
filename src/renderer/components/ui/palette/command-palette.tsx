import { useEffect, useId, useRef, useState } from "react";
import {
  initialPaletteSearchSnapshot,
  PaletteSearchController,
  type PaletteSearchSnapshot,
  type PaletteViewStatus,
  resolvePaletteKeyAction,
} from "./controller";
import type { PaletteItem, PaletteSource } from "./types";
import { trapTab } from "./utils";
import { CommandPaletteFrame as Frame } from "./command-palette-frame";

export { CommandPaletteFrame, type CommandPaletteFrameProps } from "./command-palette-frame";

interface CommandPaletteProps<TItem extends PaletteItem> {
  open: boolean;
  source: PaletteSource<TItem> | null;
  onClose: () => void;
}

export function restoreFocusOnUnmount(target: HTMLElement | null): void {
  if (target?.isConnected && !target.hasAttribute("disabled")) {
    target.focus({ preventScroll: true });
  }
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
      restoreFocusOnUnmount(target);
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
    <Frame
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
      dimmed={snapshot.dimmed ?? false}
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
