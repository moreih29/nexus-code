// DataGrid — rows of fields in columns, for the table previews (CSV, TSV,
// spreadsheets).
//
// The header row stays in view as the grid scrolls, and each row's number
// stays at its left. Columns keep the widths they are given; a field wider
// than its column is cut, with its whole text in its tooltip. Only the rows in view are in
// the DOM, so a large table scrolls smoothly. Fields are text: nothing in
// them is interpreted.

import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef } from "react";
import { displayWidth } from "../../../services/editor/preview/delimited";
import { cn } from "../../../utils/cn";

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
                  <Field key={column} field={row?.[column]} Cell="td" width={widths[column] ?? 0} />
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
}: {
  field: GridField | undefined;
  Cell: "th" | "td";
  /** The column's width, in characters, past which the text is cut. */
  width: number;
  center?: boolean;
}) {
  const text = field?.text ?? "";
  const line = text.replace(/\r?\n/g, " ↵ ");
  return (
    <Cell
      className={cn(
        "truncate px-2 leading-6 border-l border-border/50",
        center ? "text-center" : field?.end ? "text-right" : "text-left",
      )}
      title={displayWidth(line) > width ? text : undefined}
    >
      {line}
    </Cell>
  );
}
