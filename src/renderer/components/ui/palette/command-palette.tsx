import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CommandPaletteFrame as Frame } from "./command-palette-frame";
import {
  initialPaletteSearchSnapshot,
  PaletteSearchController,
  type PaletteSearchSnapshot,
  type PaletteViewStatus,
  paletteAcceptContextFromInput,
  resolvePaletteKeyAction,
} from "./controller";
import type { PaletteAcceptContext, PaletteItem, PaletteSource } from "./types";
import { trapTab } from "./utils";

export { CommandPaletteFrame, type CommandPaletteFrameProps } from "./command-palette-frame";

interface CommandPaletteProps<TItem extends PaletteItem> {
  open: boolean;
  source: PaletteSource<TItem> | null;
  onClose: () => void;
  footer?: React.ReactNode;
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
  footer,
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
  const { t } = useTranslation();
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

  // Document-level Escape handler. The frame's onKeyDown only fires when
  // focus is inside the dialog (input/listbox); if the user clicked
  // through the overlay onto the underlying app or otherwise lost focus,
  // a `keydown` on the body would never reach the dialog handler. The
  // capture-phase listener guarantees Escape closes the palette as long
  // as it is open, matching the behavior users expect from Radix Dialog
  // and from VS Code's quick-pick.
  useEffect(() => {
    if (!open) return;
    function handleDocumentKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
    document.addEventListener("keydown", handleDocumentKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleDocumentKeyDown, true);
    };
  }, [open, onClose]);

  if (!open) return null;

  const status: PaletteViewStatus = source ? snapshot.status : "no-workspace";

  async function accept(context: PaletteAcceptContext): Promise<void> {
    if (!source) return;
    let activeSnapshot = snapshot;
    if (
      (snapshot.status === "debouncing" || snapshot.status === "loading") &&
      controllerRef.current !== null
    ) {
      activeSnapshot = await controllerRef.current.flush();
    }
    if (activeSnapshot.activeIndex < 0) return;
    const item = activeSnapshot.items[activeSnapshot.activeIndex];
    if (!item) return;
    onClose();
    source.accept(item, context);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    const action = resolvePaletteKeyAction(
      {
        key: e.key,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
      },
      snapshot.activeIndex,
      snapshot.items.length,
    );

    if (action.kind === "none") return;
    e.preventDefault();

    if (action.kind === "move") {
      setSnapshot((current) => ({ ...current, activeIndex: action.activeIndex }));
    } else if (action.kind === "accept") {
      void accept(paletteAcceptContextFromInput(e, action.mode));
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
      title={source?.title ?? t("palette.go_to_symbol")}
      placeholder={source?.placeholder ?? t("palette.search_symbols")}
      query={query}
      items={snapshot.items}
      activeIndex={snapshot.activeIndex}
      dimmed={snapshot.dimmed ?? false}
      emptyQueryMessage={source?.emptyQueryMessage ?? t("palette.no_workspace")}
      noResultsMessage={source?.noResultsMessage ?? t("palette.no_results")}
      onQueryChange={setQuery}
      onKeyDown={handleKeyDown}
      onOverlayClick={onClose}
      footer={footer}
      onHoverItem={(index) => setSnapshot((current) => ({ ...current, activeIndex: index }))}
      onAcceptItem={(index) => {
        setSnapshot((current) => ({ ...current, activeIndex: index }));
        if (!source) return;
        const item = snapshot.items[index];
        if (!item) return;
        onClose();
        source.accept(item, paletteAcceptContextFromInput({}, "default"));
      }}
    />
  );
}
