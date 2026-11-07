// JsonTreePreview — a JSON file, or one of another format read into the
// same values (YAML), as a tree of its values.
//
// Objects and arrays open and close, one at a time or all at once; a
// small file opens whole, a large one with only its top level. Only the
// rows in view are in the DOM, so a large file scrolls smoothly. What is
// open is kept by each value's place in the tree, so it holds as the
// file changes. The keys work as in a tree: up and down move, right
// opens, left closes or goes to the parent, Enter and Space toggle.
//
// Find (⌘F) goes through every key and value, those in closed objects
// and arrays too; the current match's row is opened to and scrolled into
// view.

import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight, ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { MAX_FIND_MATCHES } from "@/services/editor/preview/find/dom-finder";
import { findMatches } from "@/services/editor/preview/find/find-matches";
import {
  ancestorPaths,
  countValues,
  hasChildren,
  type JsonRow,
  JsonSyntaxError,
  type JsonValue,
  labelText,
  parseJson,
  type TreeMatch,
  treeMatches,
  valueText,
  visibleRows,
} from "@/services/editor/preview/json-tree";
import { cn } from "../../../utils/cn";
import { IconButton } from "../../ui/icon-button";
import { type FindMark, type FindResult, MarkedLine, usePreviewFinder } from "./preview-find";

/** A row's height, in px. */
const ROW_PX = 22;
/** How far each level is set in, in px. */
const INDENT_PX = 16;
/** A file with up to this many values opens whole. */
const OPEN_ALL_LIMIT = 5000;
/** Past this many characters a file is not drawn as a tree. */
const MAX_TREE_CHARS = 16 * 1024 * 1024;
/** How much of a long string its tooltip shows. */
const MAX_TITLE_CHARS = 2000;
/** The toolbar's height, in px, which the find bar sits below. */
const TOOLBAR_PX = 33;

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

/** Whether the row at `path` is open in `state`, for a file of `count` values. */
function isOpenIn(state: OpenState, count: number, path: string): boolean {
  const base =
    state.base === "all" ? true : state.base === "none" ? false : count <= OPEN_ALL_LIMIT;
  return base !== state.toggled.has(path);
}

/** `state` with every object and array `path` is in open. */
function openTo(state: OpenState, count: number, path: string): OpenState {
  const closed = ancestorPaths(path).filter((ancestor) => !isOpenIn(state, count, ancestor));
  if (closed.length === 0) return state;
  const toggled = new Set(state.toggled);
  for (const ancestor of closed) if (!toggled.delete(ancestor)) toggled.add(ancestor);
  return { base: state.base, toggled };
}

/** A row's marks: in its key, and in its value. */
interface RowMarks {
  readonly label: FindMark[];
  readonly value: FindMark[];
}

/** A format the tree reads: its name, as messages say it, and its reader. */
export interface TreeFormat {
  readonly name: string;
  readonly parse: (source: string) => JsonValue;
}

const JSON_FORMAT: TreeFormat = { name: "JSON", parse: parseJson };

function parse(source: string, format: TreeFormat): Parsed {
  if (source.length > MAX_TREE_CHARS) return { kind: "too_large" };
  if (source.trim() === "") return { kind: "empty" };
  try {
    const root = format.parse(source);
    return { kind: "ok", root, count: countValues(root) };
  } catch (error) {
    if (error instanceof JsonSyntaxError) return { kind: "error", error };
    throw error;
  }
}

export function JsonTreePreview({
  source,
  format = JSON_FORMAT,
}: {
  source: string;
  format?: TreeFormat;
}) {
  const { t } = useTranslation();
  const parsed = useMemo(() => parse(source, format), [source, format]);

  if (parsed.kind === "ok") {
    return <JsonTree root={parsed.root} count={parsed.count} format={format.name} />;
  }
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
              format: format.name,
              line: parsed.error.line,
              column: parsed.error.column,
            })}
    </div>
  );
}

function JsonTree({ root, count, format }: { root: JsonValue; count: number; format: string }) {
  const { t } = useTranslation();
  const id = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(INITIAL_OPEN);
  const [activePath, setActivePath] = useState<string | null>(null);

  const isOpen = useCallback((path: string) => isOpenIn(open, count, path), [open, count]);
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

  const [find, setFind] = useState<{ query: string; caseSensitive: boolean } | null>(null);
  const [current, setCurrent] = useState(-1);
  const reportRef = useRef<(result: FindResult) => void>(() => {});
  const finding = find !== null;
  /** Every row, every object and array open: what a find goes through. */
  const allRows = useMemo(() => (finding ? visibleRows(root, () => true) : []), [finding, root]);
  const matches = useMemo(
    () =>
      find
        ? treeMatches(allRows, (text) =>
            findMatches(text, find.query, find.caseSensitive, MAX_FIND_MATCHES),
          )
        : [],
    [find, allRows],
  );
  const matchesRef = useRef(matches);
  matchesRef.current = matches;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  /** Whether the next matches start at the view, as a new query does. */
  const freshRef = useRef(false);
  /** Whether the current match is to be opened to and scrolled to. */
  const revealRef = useRef(false);

  usePreviewFinder(
    useCallback((report: (result: FindResult) => void) => {
      reportRef.current = report;
      return {
        barTop: TOOLBAR_PX + 8,
        search(query: string, caseSensitive: boolean) {
          freshRef.current = true;
          setFind(query.trim() ? { query, caseSensitive } : null);
        },
        move(direction: 1 | -1) {
          const total = matchesRef.current.length;
          if (total === 0) return;
          revealRef.current = true;
          setCurrent((at) => (at + direction + total) % total);
        },
        clear() {
          setFind(null);
        },
      };
    }, []),
  );

  // New matches: a new query's start at the first row in view; a file
  // that changed keeps the current one as near as it can.
  useEffect(() => {
    if (matches.length === 0) {
      setCurrent(-1);
      return;
    }
    if (freshRef.current) {
      freshRef.current = false;
      revealRef.current = true;
      const top = rowsRef.current[Math.floor((scrollRef.current?.scrollTop ?? 0) / ROW_PX)];
      const order = top ? allRows.findIndex((row) => row.path === top.path) : 0;
      const first = matches.findIndex((match) => match.row >= order);
      setCurrent(first === -1 ? 0 : first);
    } else {
      setCurrent((at) => Math.min(Math.max(at, 0), matches.length - 1));
    }
  }, [matches, allRows]);

  const currentMatch: TreeMatch | undefined = current >= 0 ? matches[current] : undefined;
  useEffect(() => {
    reportRef.current({ total: matches.length, current: currentMatch ? current + 1 : 0 });
  }, [matches.length, current, currentMatch]);

  // The current match's row: its objects and arrays opened, then, drawn
  // with them open, scrolled to the middle and across to the match.
  useEffect(() => {
    if (!currentMatch || !revealRef.current) return;
    const index = rows.findIndex((row) => row.path === currentMatch.path);
    if (index === -1) {
      setOpen((state) => openTo(state, count, currentMatch.path));
      return;
    }
    revealRef.current = false;
    virtualizer.scrollToIndex(index, { align: "center" });
    const frame = requestAnimationFrame(() => {
      const scroller = scrollRef.current;
      const mark = scroller?.querySelector<HTMLElement>("[data-find-current]");
      if (!scroller || !mark) return;
      const box = scroller.getBoundingClientRect();
      const at = mark.getBoundingClientRect();
      if (at.left < box.left || at.right > box.right) {
        scroller.scrollLeft += at.left - box.left - (box.width - at.width) / 2;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [currentMatch, rows, count, virtualizer]);

  /** Each row's marks, by its path. */
  const marks = useMemo(() => {
    const byRow = new Map<string, RowMarks>();
    matches.forEach((match, index) => {
      let row = byRow.get(match.path);
      if (!row) {
        row = { label: [], value: [] };
        byRow.set(match.path, row);
      }
      row[match.part].push({ start: match.start, end: match.end, current: index === current });
    });
    return byRow;
  }, [matches, current]);

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

  return (
    <div className="flex flex-col h-full min-h-0 bg-[var(--surface-backdrop-bg)]">
      <div className="flex shrink-0 items-center justify-end gap-1 px-2 py-1 border-b border-border">
        <IconButton
          label={t("jsonPreview.expand_all")}
          onClick={() => setOpen({ base: "all", toggled: new Set() })}
        >
          <ChevronsUpDown className="size-3.5" />
        </IconButton>
        <IconButton
          label={t("jsonPreview.collapse_all")}
          onClick={() => setOpen({ base: "none", toggled: new Set() })}
        >
          <ChevronsDownUp className="size-3.5" />
        </IconButton>
      </div>
      <div
        ref={scrollRef}
        role="tree"
        tabIndex={0}
        aria-label={t("jsonPreview.label", { format })}
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
                <RowText row={row} marks={marks.get(row.path)} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function RowText({ row, marks }: { row: JsonRow; marks?: RowMarks }) {
  const { t } = useTranslation();
  const { label, value } = row;
  const text = valueText(value);
  const line = (part: string, at?: readonly FindMark[]) =>
    at && at.length > 0 ? <MarkedLine line={part} marks={at} /> : part;
  return (
    <>
      {label !== null && (
        <span>
          <span
            className={
              typeof label === "number" ? "text-muted-foreground" : "text-[var(--syntax-property)]"
            }
          >
            {line(labelText(label), marks?.label)}
          </span>
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
      ) : (
        <span
          className={
            value.kind === "string"
              ? "text-[var(--syntax-string)]"
              : value.kind === "number"
                ? "text-[var(--syntax-number)]"
                : "text-[var(--syntax-constant)]"
          }
          title={value.kind === "string" ? stringTitle(value.value) : undefined}
        >
          {line(text ?? "", marks?.value)}
        </span>
      )}
    </>
  );
}

/** A long string's tooltip: more of it than its row shows. */
function stringTitle(value: string): string | undefined {
  const text = JSON.stringify(value);
  return text.length > 80 ? text.slice(0, MAX_TITLE_CHARS) : undefined;
}
