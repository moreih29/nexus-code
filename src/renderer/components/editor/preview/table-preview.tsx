// TablePreview — a .csv or .tsv file as a table.
//
// The first row is the header. Columns take the width of their widest
// field among the first rows, within a cap, and keep it as the table
// scrolls (see DataGrid).

import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { columnWidths, parseDelimited } from "@/services/editor/preview/delimited";
import { capPreviewSource, getPreviewTruncatedMessage } from "./constants";
import { DataGrid, type GridField } from "./data-grid";

interface TablePreviewProps {
  source: string;
  delimiter: string;
}

export function TablePreview({ source, delimiter }: TablePreviewProps) {
  const { t } = useTranslation();
  const { text, truncated } = capPreviewSource(source);
  const table = useMemo(() => parseDelimited(text, delimiter), [text, delimiter]);
  const widths = useMemo(() => columnWidths(table), [table]);
  const [header, ...body] = table.rows;
  const rowAt = useCallback(
    (index: number): GridField[] | undefined =>
      table.rows[index + 1]?.map((field) => ({ text: field })),
    [table],
  );

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
        <DataGrid header={header} rowCount={body.length} rowAt={rowAt} widths={widths} />
      )}
    </div>
  );
}
