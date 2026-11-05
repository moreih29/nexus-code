// TablePreview — a .csv or .tsv file as a table.
//
// The first row is the header, kept in view as the table scrolls. Columns
// take the width of their widest field among the first rows, within a cap,
// and keep it as the table scrolls; a longer field is cut, with its whole
// text in its tooltip. Only the rows in view are in the DOM, so a file up to
// the preview cap scrolls smoothly. Fields are text: nothing in them is
// interpreted.

import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { columnWidths, parseDelimited } from "@/services/editor/preview/delimited";
import { capPreviewSource, getPreviewTruncatedMessage } from "./constants";

/** A row's height, in px: one line of the UI's small text with its padding. */
const ROW_PX = 24;
/** Space a field gets beside its text, in px. */
const FIELD_PADDING_PX = 16;

interface TablePreviewProps {
  source: string;
  delimiter: string;
}

export function TablePreview({ source, delimiter }: TablePreviewProps) {
  const { t } = useTranslation();
  const { text, truncated } = capPreviewSource(source);
  const table = useMemo(() => parseDelimited(text, delimiter), [text, delimiter]);
  const widths = useMemo(() => columnWidths(table), [table]);
  /** Each column's number, which keys its fields in a row. */
  const columns = useMemo(
    () => Array.from({ length: table.columns }, (_, column) => column),
    [table.columns],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const [header, ...body] = table.rows;
  const gutter = Math.max(3, String(body.length).length + 1);
  const template = [
    `${gutter}ch`,
    ...widths.map((w) => `calc(${w}ch + ${FIELD_PADDING_PX}px)`),
  ].join(" ");

  const virtualizer = useVirtualizer({
    count: body.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_PX,
    overscan: 20,
  });

  return (
    <div className="flex flex-col h-full min-h-0 bg-[var(--surface-backdrop-bg)]">
      {truncated && (
        <div
          role="status"
          className="px-3 py-1 text-app-ui-sm text-[var(--state-warning-fg)] bg-[var(--state-warning-bg)] border-b border-[var(--state-warning-border)]"
        >
          {getPreviewTruncatedMessage()}
        </div>
      )}
      {header === undefined ? (
        <div className="p-4 text-app-ui-sm text-muted-foreground">{t("preview.table_empty")}</div>
      ) : (
        <div
          ref={scrollRef}
          className="app-scrollbar flex-1 min-h-0 overflow-auto font-mono text-app-ui-sm"
        >
          <table
            className="block w-max min-w-full border-collapse"
            aria-rowcount={table.rows.length}
            aria-colcount={table.columns}
          >
            <thead className="sticky top-0 z-20 block">
              <tr
                aria-rowindex={1}
                className="grid border-b border-border bg-[var(--surface-island-bg)] font-semibold"
                style={{ gridTemplateColumns: template, height: ROW_PX }}
              >
                <th className="sticky left-0 z-10 bg-[var(--surface-island-bg)]" />
                {columns.map((column) => (
                  <Field key={column} text={header[column] ?? ""} Cell="th" />
                ))}
              </tr>
            </thead>
            <tbody className="relative block" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => {
                const row = body[item.index] ?? [];
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
                      <Field key={column} text={row[column] ?? ""} Cell="td" />
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** One field, on one line: a longer one is cut, its whole text in the tooltip. */
function Field({ text, Cell }: { text: string; Cell: "th" | "td" }) {
  const line = text.replace(/\r?\n/g, " ↵ ");
  return (
    <Cell
      className="truncate px-2 leading-6 text-left border-l border-border/50"
      title={line.length > 20 ? text : undefined}
    >
      {line}
    </Cell>
  );
}
