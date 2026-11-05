// DataGrid — rows of fields in columns, for the table previews (CSV, TSV,
// spreadsheets).
//
// The header row stays in view as the grid scrolls, and each row's number
// stays at its left. Columns keep the widths they are given; a field wider
// than its column is cut, with its whole text in its tooltip. Only the rows in view are in
// the DOM, so a large table scrolls smoothly. Fields are text: nothing in
// them is interpreted.
//
// Find (⌘F) goes through the fields themselves, not the rows drawn, and
// scrolls the current match's row and column into view.

import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { displayWidth } from "../../../services/editor/preview/delimited";
import { MAX_FIND_MATCHES } from "../../../services/editor/preview/find/dom-finder";
import { findMatches } from "../../../services/editor/preview/find/find-matches";
import { cn } from "../../../utils/cn";
import { type FindMark, type FindResult, MarkedLine, usePreviewFinder } from "./preview-find";

/** A row's height, in px: one line of the UI's small text with its padding. */
const ROW_PX = 24;
/** Space a field gets beside its text, in px. */
const FIELD_PADDING_PX = 16;

export interface GridField {
  readonly text: string;
  /** Lined up at the right, as numbers are. */
  readonly end?: boolean;
}

interface DataGridProps {
  /** Each column's title, in the header row. */
  header: readonly string[];
  rowCount: number;
  /** The fields of the row at `index`, by column; a missing one is empty. */
  rowAt: (index: number) => readonly (GridField | undefined)[] | undefined;
  /** Each column's width, in characters. */
  widths: readonly number[];
  /** The header's text at the middle of its column rather than its start. */
  centerHeader?: boolean;
}

/** A match of the find in a field: its row, column, and place in the field's line. */
interface GridMatch {
  readonly row: number;
  readonly column: number;
  readonly start: number;
  readonly end: number;
}

/** A field's text on its one line. */
function lineOf(text: string): string {
  return text.replace(/\r?\n/g, " ↵ ");
}

/** The matches of `query` in the fields, row by row. */
function gridMatches(
  rowCount: number,
  rowAt: DataGridProps["rowAt"],
  columns: number,
  query: string,
  caseSensitive: boolean,
): GridMatch[] {
  const matches: GridMatch[] = [];
  for (let row = 0; row < rowCount; row++) {
    const fields = rowAt(row);
    if (!fields) continue;
    for (let column = 0; column < columns; column++) {
      const text = fields[column]?.text;
      if (!text) continue;
      const left = MAX_FIND_MATCHES - matches.length;
      const found = findMatches(lineOf(text), query, caseSensitive, left);
      for (let i = 0; i < found.length; i += 2) {
        matches.push({ row, column, start: found[i] as number, end: found[i + 1] as number });
      }
      if (matches.length >= MAX_FIND_MATCHES) return matches;
    }
  }
  return matches;
}

export function DataGrid({ header, rowCount, rowAt, widths, centerHeader }: DataGridProps) {
  /** Each column's number, which keys its fields in a row. */
  const columns = useMemo(
    () => Array.from({ length: widths.length }, (_, column) => column),
    [widths.length],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const gutter = Math.max(3, String(rowCount).length + 1);
  const template = [
    `${gutter}ch`,
    ...widths.map((w) => `calc(${w}ch + ${FIELD_PADDING_PX}px)`),
  ].join(" ");

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_PX,
    overscan: 20,
  });

  const [find, setFind] = useState<{ query: string; caseSensitive: boolean } | null>(null);
  const [current, setCurrent] = useState(-1);
  const reportRef = useRef<(result: FindResult) => void>(() => {});
  const matches = useMemo(
    () => (find ? gridMatches(rowCount, rowAt, widths.length, find.query, find.caseSensitive) : []),
    [find, rowCount, rowAt, widths.length],
  );
  const matchesRef = useRef(matches);
  matchesRef.current = matches;
  /** Whether the next matches start at the view, as a new query does. */
  const freshRef = useRef(false);
  /** Whether the current match is to be scrolled to. */
  const revealRef = useRef(false);

  usePreviewFinder(
    useCallback((report: (result: FindResult) => void) => {
      reportRef.current = report;
      return {
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

  // New matches: a new query's start at the first row in view; a table
  // that changed keeps the current one as near as it can.
  useEffect(() => {
    if (matches.length === 0) {
      setCurrent(-1);
      return;
    }
    if (freshRef.current) {
      freshRef.current = false;
      revealRef.current = true;
      const top = Math.floor((scrollRef.current?.scrollTop ?? 0) / ROW_PX);
      const first = matches.findIndex((match) => match.row >= top);
      setCurrent(first === -1 ? 0 : first);
    } else {
      setCurrent((at) => Math.min(Math.max(at, 0), matches.length - 1));
    }
  }, [matches]);

  const currentMatch = current >= 0 ? matches[current] : undefined;
  useEffect(() => {
    reportRef.current({ total: matches.length, current: currentMatch ? current + 1 : 0 });
  }, [matches.length, current, currentMatch]);

  useEffect(() => {
    if (!currentMatch || !revealRef.current) return;
    revealRef.current = false;
    virtualizer.scrollToIndex(currentMatch.row, { align: "center" });
    // The row is drawn on the next frame; then its field comes into view.
    const frame = requestAnimationFrame(() => {
      const scroller = scrollRef.current;
      const mark = scroller?.querySelector<HTMLElement>("[data-find-current]");
      if (!scroller || !mark) return;
      const box = scroller.getBoundingClientRect();
      const at = mark.getBoundingClientRect();
      const gutterPx =
        (mark.closest("tr")?.firstElementChild as HTMLElement | null)?.offsetWidth ?? 0;
      if (at.left < box.left + gutterPx || at.right > box.right) {
        scroller.scrollLeft +=
          at.left - box.left - gutterPx - (box.width - gutterPx - at.width) / 2;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [currentMatch, virtualizer]);

  /** Each field's marks, by "row:column". */
  const marks = useMemo(() => {
    const byField = new Map<string, FindMark[]>();
    matches.forEach((match, index) => {
      const key = `${match.row}:${match.column}`;
      const list = byField.get(key) ?? [];
      list.push({ start: match.start, end: match.end, current: index === current });
      byField.set(key, list);
    });
    return byField;
  }, [matches, current]);

  return (
    <div
      ref={scrollRef}
      className="app-scrollbar flex-1 min-h-0 overflow-auto font-mono text-app-ui-sm"
    >
      <table
        className="block w-max min-w-full border-collapse"
        aria-rowcount={rowCount + 1}
        aria-colcount={widths.length}
      >
        <thead className="sticky top-0 z-20 block">
          <tr
            aria-rowindex={1}
            className="grid border-b border-border bg-[var(--surface-island-bg)] font-semibold"
            style={{ gridTemplateColumns: template, height: ROW_PX }}
          >
            <th className="sticky left-0 z-10 bg-[var(--surface-island-bg)]" />
            {columns.map((column) => (
              <Field
                key={column}
                field={{ text: header[column] ?? "" }}
                Cell="th"
                width={widths[column] ?? 0}
                center={centerHeader}
              />
            ))}
          </tr>
        </thead>
        <tbody className="relative block" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rowAt(item.index);
            return (
              <tr
                key={item.key}
                aria-rowindex={item.index + 2}
                className="absolute left-0 grid w-full border-b border-border/50"
                style={{
                  gridTemplateColumns: template,
                  height: ROW_PX,
                  transform: `translateY(${item.start}px)`,
                }}
              >
                <td className="sticky left-0 z-10 px-1 leading-6 text-right text-muted-foreground bg-[var(--surface-backdrop-bg)] select-none">
                  {item.index + 1}
                </td>
                {columns.map((column) => (
                  <Field
                    key={column}
                    field={row?.[column]}
                    Cell="td"
                    width={widths[column] ?? 0}
                    marks={marks.get(`${item.index}:${column}`)}
                  />
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** One field, on one line: a longer one is cut, its whole text in the tooltip. */
function Field({
  field,
  Cell,
  width,
  center,
  marks,
}: {
  field: GridField | undefined;
  Cell: "th" | "td";
  /** The column's width, in characters, past which the text is cut. */
  width: number;
  center?: boolean;
  /** The find's matches in the field's line. */
  marks?: readonly FindMark[];
}) {
  const text = field?.text ?? "";
  const line = lineOf(text);
  return (
    <Cell
      className={cn(
        "truncate px-2 leading-6 border-l border-border/50",
        center ? "text-center" : field?.end ? "text-right" : "text-left",
      )}
      title={displayWidth(line) > width ? text : undefined}
    >
      {marks ? <MarkedLine line={line} marks={marks} /> : line}
    </Cell>
  );
}
