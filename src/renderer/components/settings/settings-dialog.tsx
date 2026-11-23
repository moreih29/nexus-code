import { ChevronRight } from "lucide-react";
import { Dialog as RadixDialog } from "radix-ui";
import { useCallback, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { DIALOG_OVERLAY_CLASS, dialogContentClass } from "../ui/dialog";
import { DialogCloseButton } from "../ui/dialog-close-button";
import { escapeClearsSearch, SearchInput } from "../ui/search-input";
import { useDialogFocusReturn } from "../ui/use-dialog-focus-return";
import { navMatches, useSettingsNav } from "./nav";
import type { SettingsNavItem } from "./types";

const SETTINGS_NAV_WIDTH_PX = 180;

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultActiveId?: string;
  children: (activeId: string, go: (id: string) => void) => React.ReactNode;
}

export function SettingsDialog({
  open,
  onOpenChange,
  defaultActiveId,
  children,
}: SettingsDialogProps) {
  const { t } = useTranslation("settings");
  const returnFocus = useDialogFocusReturn(open);

  const resolvedNav = useSettingsNav(open);

  const firstId = resolvedNav[0]?.id ?? "appearance";
  const [activeId, setActiveId] = useState<string>(defaultActiveId ?? firstId);
  const [query, setQuery] = useState("");

  const openedAt = open ? defaultActiveId : undefined;
  const [shownAt, setShownAt] = useState(openedAt);
  if (openedAt !== shownAt) {
    setShownAt(openedAt);
    if (openedAt) setActiveId(openedAt);
  }

  const panelId = useId();
  const searchId = useId();

  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const filteredNav = useMemo<SettingsNavItem[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return resolvedNav;
    const found = resolvedNav.filter((item) => navMatches(item, q));
    if (found.length === 0) return [];
    const shown = new Set([...found.map((item) => item.id), activeId]);
    for (const item of resolvedNav) {
      if (item.parent && shown.has(item.id)) shown.add(item.parent);
    }
    return resolvedNav.filter((item) => shown.has(item.id));
  }, [resolvedNav, query, activeId]);

  const [mainNav, footerNav] = useMemo(
    () => [filteredNav.filter((item) => !item.footer), filteredNav.filter((item) => item.footer)],
    [filteredNav],
  );
  const orderedNav = useMemo(() => [...mainNav, ...footerNav], [mainNav, footerNav]);
  const firstFound = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? orderedNav.find((item) => navMatches(item, q))?.id : undefined;
  }, [orderedNav, query]);
  const fromSearch = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "Enter") return;
    const id = firstFound ?? (event.key === "ArrowDown" && !query.trim() ? activeId : undefined);
    if (!id) return;
    event.preventDefault();
    setActiveId(id);
    tabRefs.current.get(id)?.focus();
  };
  const activeItem = resolvedNav.find((item) => item.id === activeId);
  const activeParent = activeItem?.parent
    ? resolvedNav.find((item) => item.id === activeItem.parent)
    : undefined;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();

      const ids = orderedNav.map((item) => item.id);
      const currentIdx = ids.indexOf(activeId);
      if (currentIdx === -1) return;

      const nextIdx =
        e.key === "ArrowDown"
          ? (currentIdx + 1) % ids.length
          : (currentIdx - 1 + ids.length) % ids.length;

      const nextId = ids[nextIdx];
      if (nextId !== undefined) {
        setActiveId(nextId);
        tabRefs.current.get(nextId)?.focus();
      }
    },
    [orderedNav, activeId],
  );

  const renderTab = (item: SettingsNavItem) => {
    const isActive = item.id === activeId;
    return (
      <button
        key={item.id}
        type="button"
        role="tab"
        id={`settings-tab-${item.id}`}
        aria-selected={isActive}
        aria-controls={isActive ? `${panelId}-${item.id}` : undefined}
        tabIndex={isActive ? 0 : -1}
        ref={(el) => {
          if (el) tabRefs.current.set(item.id, el);
          else tabRefs.current.delete(item.id);
        }}
        onClick={() => setActiveId(item.id)}
        className={cn(
          "relative flex w-full items-center justify-between gap-2 py-1.5 pr-4 text-left text-app-body font-sans",
          item.parent
            ? "pl-8 before:absolute before:inset-y-0 before:left-5 before:w-px before:bg-border"
            : "pl-4",
          "border-l-2 transition-colors cursor-pointer select-none",
          isActive
            ? [
                "border-l-[var(--state-selected-indicator)]",
                "bg-[var(--sidebar-item-selected-bg)]",
                "text-[var(--sidebar-item-selected-fg)]",
              ]
            : [
                "border-l-transparent",
                "text-muted-foreground",
                "hover:bg-[var(--state-hover-bg)] hover:text-foreground",
              ],
        )}
      >
        <span className="truncate">{item.label}</span>
        {item.dirty && (
          <span
            role="img"
            aria-label={t("dialog.modifiedAria")}
            title={t("dialog.modifiedTitle")}
            className="size-1.5 shrink-0 rounded-full bg-[var(--state-selected-indicator)]"
          />
        )}
      </button>
    );
  };

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={DIALOG_OVERLAY_CLASS} />
        <RadixDialog.Content
          className={dialogContentClass("xl", false, "flex flex-col")}
          onCloseAutoFocus={returnFocus}
          onEscapeKeyDown={escapeClearsSearch}
          style={{
            height: "clamp(480px, 80vh, 640px)",
          }}
          aria-describedby={undefined}
        >
          <RadixDialog.Title className="sr-only">{t("title")}</RadixDialog.Title>

          <div className="flex flex-1 min-h-0">
            <nav
              style={{ width: SETTINGS_NAV_WIDTH_PX }}
              className="shrink-0 flex flex-col border-r border-border py-3"
              aria-label={t("dialog.nav")}
            >
              <div className="px-3 pb-2">
                <SearchInput
                  id={searchId}
                  value={query}
                  onChange={setQuery}
                  onKeyDown={fromSearch}
                  label={t("dialog.search.placeholder")}
                />
              </div>

              <div
                role="tablist"
                aria-orientation="vertical"
                onKeyDown={handleKeyDown}
                className="flex min-h-0 flex-1 flex-col overflow-y-auto app-scrollbar"
              >
                {mainNav.map(renderTab)}
                {footerNav.length > 0 && (
                  <div className="mt-auto pt-2">
                    <div className="mx-3 mb-1 border-t border-border" aria-hidden="true" />
                    {footerNav.map(renderTab)}
                  </div>
                )}
                {filteredNav.length === 0 && (
                  <div className="px-4 py-3 text-app-ui-sm text-muted-foreground">
                    {t("dialog.search.empty")}
                  </div>
                )}
              </div>
            </nav>

            <div className="flex flex-1 flex-col min-w-0 min-h-0">
              <div className="flex items-center justify-between gap-4 pl-6 pr-4 py-3 border-b border-border">
                <h2 className="flex min-w-0 items-center gap-1.5 text-app-body-emphasis text-foreground">
                  {activeParent && (
                    <>
                      <button
                        type="button"
                        onClick={() => setActiveId(activeParent.id)}
                        className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
                      >
                        {activeParent.label}
                      </button>
                      <ChevronRight
                        className="size-3.5 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                    </>
                  )}
                  <span className="truncate">{activeItem?.label}</span>
                </h2>
                <DialogCloseButton label={t("dialog.close")} />
              </div>

              <div
                className="flex-1 overflow-y-auto app-scrollbar"
                role="tabpanel"
                id={`${panelId}-${activeId}`}
                aria-labelledby={`settings-tab-${activeId}`}
              >
                <div className="px-6 py-4">{children(activeId, setActiveId)}</div>
              </div>
            </div>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
