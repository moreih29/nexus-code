// src/renderer/components/settings/settings-dialog.tsx — Settings dialog shell.
//
// Composite dialog with left nav + right panel. Inner widths are derived from
// the dialog `xl` size (720px) minus the SETTINGS_NAV_WIDTH constant below —
// the magic 156/544 split lived only at the callsite before.
//
// Left nav now carries a search box at the top and an optional dirty-dot per
// row so users can scan which panels they've already touched in this session.
//
// Props:
//   open           — controlled open state
//   onOpenChange   — Radix open-change contract
//   nav            — nav item list (optional; defaults to built-in items)
//   defaultActiveId — initial panel selection
//   children       — render prop: (activeId: string) => ReactNode
//
// ARIA: role=tablist (left nav), role=tab (each item), role=tabpanel (right),
//       arrow-key navigation, sr-only title.
//
// Design seal: semantic tokens only, no hex/oklch/rgba literals,
// no magic pixel values, no shadows.

import { Search, X } from "lucide-react";
import { Dialog as RadixDialog } from "radix-ui";
import { useCallback, useId, useMemo, useRef, useState } from "react";
import { cn } from "@/utils/cn";
import { DIALOG_OVERLAY_CLASS, dialogContentClass } from "../ui/dialog";
import type { SettingsNavItem } from "./types";

// ---------------------------------------------------------------------------
// Default nav items
// ---------------------------------------------------------------------------

const DEFAULT_NAV: SettingsNavItem[] = [
  { id: "appearance", label: "Appearance", group: "Settings", keywords: ["theme", "opacity"] },
  {
    id: "editor",
    label: "Editor",
    group: "Settings",
    keywords: ["font", "size", "family", "ligatures", "line height"],
  },
  {
    id: "terminal",
    label: "Terminal",
    group: "Settings",
    keywords: ["font", "size", "cursor"],
  },
  {
    id: "workspaces",
    label: "Workspaces",
    group: "Settings",
    keywords: ["lsp", "language", "server", "typescript", "python"],
  },
];

// Left-nav width — single source of truth for the Settings dialog split.
// Lives here (not as a global token) because no other surface composes the
// same layout; surface this constant if a second consumer ever appears.
const SETTINGS_NAV_WIDTH_PX = 180;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nav?: SettingsNavItem[];
  defaultActiveId?: string;
  /** Render prop — receives the active nav id, returns the panel content. */
  children: (activeId: string) => React.ReactNode;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SettingsDialog({
  open,
  onOpenChange,
  nav = DEFAULT_NAV,
  defaultActiveId,
  children,
}: SettingsDialogProps) {
  const firstId = nav[0]?.id ?? "appearance";
  const [activeId, setActiveId] = useState<string>(defaultActiveId ?? firstId);
  const [query, setQuery] = useState("");

  const panelId = useId();
  const searchId = useId();

  // Refs for the nav tab buttons — used for arrow-key navigation.
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  // Filter nav items by the search query. Matches label + keywords (case-
  // insensitive substring). The active item stays visible even when filtered
  // out so the right panel doesn't blank.
  const filteredNav = useMemo<SettingsNavItem[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return nav;
    return nav.filter((item) => {
      if (item.id === activeId) return true;
      if (item.label.toLowerCase().includes(q)) return true;
      return (item.keywords ?? []).some((k) => k.toLowerCase().includes(q));
    });
  }, [nav, query, activeId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();

      const ids = filteredNav.map((item) => item.id);
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
    [filteredNav, activeId],
  );

  // Group nav items by their group label.
  const groups = groupNavItems(filteredNav);

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={DIALOG_OVERLAY_CLASS} />
        <RadixDialog.Content
          className={dialogContentClass("xl", false, "flex flex-col")}
          style={{
            // Fixed-height dialog: the body never reflows when controls change,
            // so the user never sees the modal jump as they tweak a slider /
            // toggle a section. Viewport-only clamp keeps small displays usable
            // (480 floor) while preventing oversized modals on large displays
            // (640 ceiling). Panels themselves carry `overflow-y-auto` so any
            // content beyond this height scrolls inside the right panel.
            height: "clamp(480px, 80vh, 640px)",
          }}
          aria-describedby={undefined}
        >
          {/* Visually-hidden title — Radix wires the aria-labelledby itself
              when Title is rendered as a direct child of Content. Mirroring
              the form-dialog.tsx pattern that already works in this codebase
              (the manual `aria-labelledby` + `id` we had before was racing
              Radix's own wiring and the runtime warning fired despite the
              Title being present). */}
          <RadixDialog.Title className="sr-only">Settings</RadixDialog.Title>

          {/* Main layout: left nav + right panel flex-1 */}
          <div className="flex flex-1 min-h-0">
            {/* Left nav — width sourced from SETTINGS_NAV_WIDTH_PX (no magic literal) */}
            <nav
              style={{ width: SETTINGS_NAV_WIDTH_PX }}
              className="shrink-0 flex flex-col border-r border-border py-3"
              aria-label="Settings navigation"
            >
              {/* Search */}
              <div className="px-3 pb-2">
                <label htmlFor={searchId} className="sr-only">
                  Search settings
                </label>
                <div
                  className={cn(
                    "flex items-center gap-1.5 rounded-(--radius-control)",
                    "border border-border bg-background px-2 py-1",
                    "focus-within:ring-1 focus-within:ring-ring",
                  )}
                >
                  <Search className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <input
                    id={searchId}
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search"
                    className={cn(
                      "min-w-0 flex-1 bg-transparent text-app-ui-sm text-foreground outline-none",
                      "placeholder:text-muted-foreground",
                    )}
                  />
                  {query !== "" && (
                    <button
                      type="button"
                      aria-label="Clear search"
                      onClick={() => setQuery("")}
                      className="inline-flex shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
                    >
                      <X className="size-3" aria-hidden="true" />
                    </button>
                  )}
                </div>
              </div>

              {/* Nav tabs */}
              <div
                role="tablist"
                aria-orientation="vertical"
                onKeyDown={handleKeyDown}
                className="flex flex-col"
              >
                {groups.map(({ groupLabel, items }) => (
                  <div key={groupLabel ?? "__ungrouped__"}>
                    {groupLabel && (
                      <span className="block px-4 pt-2 pb-1 text-app-label uppercase text-muted-foreground">
                        {groupLabel}
                      </span>
                    )}
                    {items.map((item) => {
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
                            "flex w-full items-center justify-between gap-2 px-4 py-1.5 text-left text-app-body font-sans",
                            // 2px indicator — matches workbench/sidebar.tsx and file-tree row.
                            // The settings nav is a Floating-layer surface (design.md §2),
                            // so it uses state.selected.* tokens rather than the sidebar
                            // region's tokens (different region → different vocabulary).
                            "border-l-2 transition-colors cursor-pointer select-none",
                            isActive
                              ? [
                                  "border-l-[var(--state-selected-indicator)]",
                                  "bg-[var(--state-selected-bg)]",
                                  "text-[var(--state-selected-fg)]",
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
                              aria-label="modified"
                              title="Modified in this session"
                              className="size-1.5 shrink-0 rounded-full bg-[var(--state-selected-indicator)]"
                            />
                          )}
                        </button>
                      );
                    })}
                  </div>
                ))}
                {filteredNav.length === 0 && (
                  <div className="px-4 py-3 text-app-ui-sm text-muted-foreground">No matches.</div>
                )}
              </div>
            </nav>

            {/* Right panel */}
            <div className="flex flex-1 flex-col min-w-0 min-h-0">
              {/* Panel header with close button */}
              <div className="flex items-center justify-end px-4 py-3 border-b border-border">
                <RadixDialog.Close asChild>
                  <button
                    type="button"
                    aria-label="Close settings"
                    className={cn(
                      "inline-flex items-center justify-center",
                      "size-7 rounded-(--radius-control)",
                      "text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground",
                      "transition-colors",
                    )}
                  >
                    <X className="size-4" aria-hidden="true" />
                  </button>
                </RadixDialog.Close>
              </div>

              {/* Scrollable panel body */}
              <div
                className="flex-1 overflow-y-auto app-scrollbar"
                role="tabpanel"
                id={`${panelId}-${activeId}`}
                aria-labelledby={`settings-tab-${activeId}`}
              >
                <div className="px-6 py-4">{children(activeId)}</div>
              </div>
            </div>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

// ---------------------------------------------------------------------------
// Helper — group nav items
// ---------------------------------------------------------------------------

interface NavGroup {
  groupLabel: string | null;
  items: SettingsNavItem[];
}

function groupNavItems(nav: SettingsNavItem[]): NavGroup[] {
  const groups: NavGroup[] = [];
  const seen = new Map<string | null, NavGroup>();

  for (const item of nav) {
    const key = item.group ?? null;
    let group = seen.get(key);
    if (!group) {
      group = { groupLabel: key, items: [] };
      groups.push(group);
      seen.set(key, group);
    }
    group.items.push(item);
  }

  return groups;
}
