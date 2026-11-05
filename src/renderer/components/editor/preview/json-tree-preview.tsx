// JsonTreePreview — a JSON file as a tree of its values.
//
// Objects and arrays open and close, one at a time or all at once; a
// small file opens whole, a large one with only its top level. Only the
// rows in view are in the DOM, so a large file scrolls smoothly. What is
// open is kept by each value's place in the tree, so it holds as the
// file changes. The keys work as in a tree: up and down move, right
// opens, left closes or goes to the parent, Enter and Space toggle.

import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight, ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { type KeyboardEvent, useCallback, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  countValues,
  hasChildren,
  type JsonRow,
  JsonSyntaxError,
  type JsonValue,
  parseJson,
  visibleRows,
} from "@/services/editor/preview/json-tree";
import { cn } from "../../../utils/cn";

/** A row's height, in px. */
const ROW_PX = 22;
/** How far each level is set in, in px. */
const INDENT_PX = 16;
/** A file with up to this many values opens whole. */
const OPEN_ALL_LIMIT = 5000;
/** Past this many characters a file is not drawn as a tree. */
const MAX_TREE_CHARS = 16 * 1024 * 1024;
/** How much of a long string its row shows; the raw view has all of it. */
const MAX_STRING_CHARS = 1000;
/** How much of a long string its tooltip shows. */
const MAX_TITLE_CHARS = 2000;

type Parsed =
  | { kind: "ok"; root: JsonValue; count: number }
  | { kind: "empty" }
  | { kind: "too_large" }
  | { kind: "error"; error: JsonSyntaxError };

/** Which rows are open: all, none, or each by its depth; then those toggled. */
interface OpenState {
  readonly base: "default" | "all" | "none";
  readonly toggled: ReadonlySet<string>;
}

const INITIAL_OPEN: OpenState = { base: "default", toggled: new Set() };

function parse(source: string): Parsed {
  if (source.length > MAX_TREE_CHARS) return { kind: "too_large" };
  if (source.trim() === "") return { kind: "empty" };
  try {
    const root = parseJson(source);
    return { kind: "ok", root, count: countValues(root) };
  } catch (error) {
    if (error instanceof JsonSyntaxError) return { kind: "error", error };
    throw error;
  }
}

export function JsonTreePreview({ source }: { source: string }) {
  const { t } = useTranslation();
  const parsed = useMemo(() => parse(source), [source]);

  if (parsed.kind === "ok") return <JsonTree root={parsed.root} count={parsed.count} />;
  return (
    <div
      role="status"
      className="h-full p-4 text-app-ui-sm text-muted-foreground bg-[var(--surface-backdrop-bg)]"
    >
      {parsed.kind === "empty"
        ? t("jsonPreview.empty")
        : parsed.kind === "too_large"
          ? t("jsonPreview.too_large", { mb: MAX_TREE_CHARS / 1024 / 1024 })
          : t("jsonPreview.syntax_error", {
              line: parsed.error.line,
              column: parsed.error.column,
            })}
    </div>
  );
}

function JsonTree({ root, count }: { root: JsonValue; count: number }) {
  const { t } = useTranslation();
  const id = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(INITIAL_OPEN);
  const [activePath, setActivePath] = useState<string | null>(null);

  const isOpen = useCallback(
    (path: string) => {
      const base =
        open.base === "all" ? true : open.base === "none" ? false : count <= OPEN_ALL_LIMIT;
      return base !== open.toggled.has(path);
    },
    [open, count],
  );
  const rows = useMemo(() => visibleRows(root, isOpen), [root, isOpen]);
  const activeIndex = activePath === null ? -1 : rows.findIndex((row) => row.path === activePath);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_PX,
    overscan: 20,
  });

  const toggle = useCallback((path: string) => {
    setOpen((state) => {
      const toggled = new Set(state.toggled);
      if (!toggled.delete(path)) toggled.add(path);
      return { base: state.base, toggled };
    });
  }, []);

  const moveTo = (index: number) => {
    const to = Math.max(0, Math.min(rows.length - 1, index));
    const row = rows[to];
    if (!row) return;
    setActivePath(row.path);
    virtualizer.scrollToIndex(to);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const row = rows[activeIndex];
    const opens = row !== undefined && hasChildren(row.value);
    switch (event.key) {
      case "ArrowDown":
        moveTo(activeIndex + 1);
        break;
      case "ArrowUp":
        moveTo(activeIndex <= 0 ? 0 : activeIndex - 1);
        break;
      case "Home":
        moveTo(0);
        break;
      case "End":
        moveTo(rows.length - 1);
        break;
      case "ArrowRight":
        if (!row) moveTo(0);
        else if (opens && !isOpen(row.path)) toggle(row.path);
        else if (opens) moveTo(activeIndex + 1);
        break;
      case "ArrowLeft": {
        if (!row) break;
        if (opens && isOpen(row.path)) {
          toggle(row.path);
          break;
        }
        let parent = activeIndex - 1;
        while (parent >= 0 && (rows[parent]?.depth ?? 0) >= row.depth) parent--;
        if (parent >= 0) moveTo(parent);
        break;
      }
      case "Enter":
      case " ":
        if (opens) toggle(row.path);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const button =
    "inline-flex items-center justify-center size-6 rounded-(--radius-control) text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground";

  return (
    <div className="flex flex-col h-full min-h-0 bg-[var(--surface-backdrop-bg)]">
      <div className="flex shrink-0 items-center justify-end gap-1 px-2 py-1 border-b border-border">
        <button
          type="button"
          className={button}
          onClick={() => setOpen({ base: "all", toggled: new Set() })}
          aria-label={t("jsonPreview.expand_all")}
          title={t("jsonPreview.expand_all")}
        >
          <ChevronsUpDown className="size-3.5" />
        </button>
        <button
          type="button"
          className={button}
          onClick={() => setOpen({ base: "none", toggled: new Set() })}
          aria-label={t("jsonPreview.collapse_all")}
          title={t("jsonPreview.collapse_all")}
        >
          <ChevronsDownUp className="size-3.5" />
        </button>
      </div>
      <div
        ref={scrollRef}
        role="tree"
        tabIndex={0}
        aria-label={t("jsonPreview.label")}
        aria-activedescendant={activeIndex >= 0 ? `${id}-${activeIndex}` : undefined}
        onKeyDown={onKeyDown}
        className="app-scrollbar flex-1 min-h-0 overflow-auto font-mono text-app-ui-sm outline-none"
      >
        {/*
          Never of no width, even in a hidden tab's box of no size: a box of
          no area adds nothing to what scrolls, which would drop the scroll.
        */}
        <div
          className="relative w-max"
          style={{ height: virtualizer.getTotalSize(), minWidth: "max(100%, 1px)" }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            const opens = hasChildren(row.value);
            const expanded = opens && isOpen(row.path);
            return (
              // biome-ignore lint/a11y/useFocusableInteractive: the tree holds the focus, and names the row it is on with aria-activedescendant.
              // biome-ignore lint/a11y/useKeyWithClickEvents: the tree's keys move between rows and toggle them.
              <div
                key={item.key}
                id={`${id}-${item.index}`}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-expanded={opens ? expanded : undefined}
                aria-selected={item.index === activeIndex}
                className={cn(
                  "absolute left-0 flex w-full items-center gap-1 pr-4 whitespace-nowrap select-text",
                  item.index === activeIndex && "bg-[var(--state-selected-bg)]",
                )}
                style={{
                  height: ROW_PX,
                  transform: `translateY(${item.start}px)`,
                  paddingLeft: 8 + row.depth * INDENT_PX,
                }}
                onClick={() => {
                  setActivePath(row.path);
                  // Not when the click ends a drag that selects text.
                  if (opens && (window.getSelection()?.isCollapsed ?? true)) toggle(row.path);
                }}
              >
                <span className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                  {opens && (
                    <ChevronRight
                      className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
                    />
                  )}
                </span>
                <RowText row={row} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Whether `text` has a control character, which would break a row's line. */
function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) < 0x20) return true;
  return false;
}

function RowText({ row }: { row: JsonRow }) {
  const { t } = useTranslation();
  const { label, value } = row;
  return (
    <>
      {label !== null && (
        <span>
          {typeof label === "number" ? (
            <span className="text-muted-foreground">{label}</span>
          ) : (
            <span className="text-[var(--syntax-property)]">
              {label === "" || hasControl(label) ? JSON.stringify(label) : label}
            </span>
          )}
          <span className="text-muted-foreground">:</span>
        </span>
      )}
      {value.kind === "object" ? (
        <span className="text-muted-foreground">
          {value.entries.length === 0
            ? "{}"
            : t("jsonPreview.keys", { count: value.entries.length })}
        </span>
      ) : value.kind === "array" ? (
        <span className="text-muted-foreground">
          {value.items.length === 0 ? "[]" : t("jsonPreview.items", { count: value.items.length })}
        </span>
      ) : value.kind === "string" ? (
        <StringText value={value.value} />
      ) : value.kind === "number" ? (
        <span className="text-[var(--syntax-number)]">{value.text}</span>
      ) : (
        <span className="text-[var(--syntax-constant)]">
          {value.kind === "null" ? "null" : String(value.value)}
        </span>
      )}
    </>
  );
}

function StringText({ value }: { value: string }) {
  const text = JSON.stringify(value);
  return (
    <span
      className="text-[var(--syntax-string)]"
      title={text.length > 80 ? text.slice(0, MAX_TITLE_CHARS) : undefined}
    >
      {text.length > MAX_STRING_CHARS ? `${text.slice(0, MAX_STRING_CHARS)}…` : text}
    </span>
  );
}
