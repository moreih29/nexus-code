// SpreadsheetPreview — an .xlsx or .xlsm workbook, one sheet at a time,
// with a tab per sheet below it.
//
// Cells show what the spreadsheet application last saved: a formula's
// computed value, numbers and dates in the cell's number format. Columns
// are lettered and rows numbered, as the application shows them. A file
// changed on disk is read again, staying on the same sheet and place.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { MAX_READABLE_FILE_SIZE } from "../../../../shared/fs/defaults";
import { readWorkspaceBinary } from "../../../services/editor/preview/read-binary";
import {
  columnName,
  MAX_SHEET_COLUMNS,
  type Sheet,
  type Workbook,
} from "../../../services/editor/preview/spreadsheet";
import { cn } from "../../../utils/cn";
import { EmptyState } from "../../ui/empty-state";
import { DataGrid, type GridField } from "./data-grid";
import { useFileVersion } from "./use-file-version";
import { useWorkspaceFile } from "./use-workspace-file";

type Status =
  | { kind: "loading" }
  | { kind: "ready"; workbook: Workbook }
  | { kind: "failed" | "too_large" | "outside" | "no-workspace" };

interface SpreadsheetPreviewProps {
  workspaceId: string;
  /** Absolute path on the workspace filesystem. */
  filePath: string;
}

export function SpreadsheetPreview({ workspaceId, filePath }: SpreadsheetPreviewProps) {
  const file = useWorkspaceFile(workspaceId, filePath);
  if (file.kind !== "inside") return <SpreadsheetStatus status={{ kind: file.kind }} />;
  return <SpreadsheetDocument workspaceId={workspaceId} relPath={file.relPath} />;
}

function SpreadsheetDocument({ workspaceId, relPath }: { workspaceId: string; relPath: string }) {
  const version = useFileVersion(workspaceId, relPath);
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  /** The sheet shown, by name, so a changed file stays on it. */
  const [shown, setShown] = useState<string | null>(null);

  // `version` is when to read the file again; the read itself goes by path.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const read = await readWorkspaceBinary(workspaceId, relPath);
      if (cancelled) return;
      if (read.kind !== "ok") {
        setStatus({ kind: read.kind });
        return;
      }
      const { readWorkbook } = await import("../../../services/editor/preview/xlsx");
      if (cancelled) return;
      try {
        setStatus({ kind: "ready", workbook: readWorkbook(read.bytes) });
      } catch {
        setStatus({ kind: "failed" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, relPath, version]);

  if (status.kind !== "ready") return <SpreadsheetStatus status={status} />;
  const { sheets } = status.workbook;
  const sheet = sheets.find((s) => s.name === shown) ?? sheets[0];
  if (!sheet) return <SpreadsheetStatus status={{ kind: "failed" }} />;
  return (
    <div className="flex flex-col h-full min-h-0 flex-1 bg-[var(--surface-backdrop-bg)]">
      <SheetView key={sheet.name} sheet={sheet} />
      <SheetTabs sheets={sheets} shown={sheet.name} onShow={setShown} />
    </div>
  );
}

function SheetView({ sheet }: { sheet: Sheet }) {
  const { t } = useTranslation();
  const header = useMemo(
    () => Array.from({ length: sheet.columns }, (_, column) => columnName(column)),
    [sheet.columns],
  );
  const rowAt = useCallback(
    (index: number): readonly (GridField | undefined)[] | undefined =>
      sheet.rows[index]?.map((cell) => cell && { text: cell.text, end: cell.numeric }),
    [sheet],
  );
  if (sheet.chart || sheet.columns === 0) {
    return (
      <EmptyState
        title={
          sheet.chart ? t("spreadsheetPreview.chart_sheet") : t("spreadsheetPreview.empty_sheet")
        }
        tone="status"
        className="flex-1 min-h-0"
      />
    );
  }
  return (
    <>
      {sheet.clipped && (
        <div
          role="status"
          className="px-3 py-1 text-app-ui-sm text-[var(--state-warning-fg)] bg-[var(--state-warning-bg)] border-b border-[var(--state-warning-border)]"
        >
          {t("spreadsheetPreview.columns_clipped", { count: MAX_SHEET_COLUMNS })}
        </div>
      )}
      <DataGrid
        header={header}
        rowCount={sheet.rows.length}
        rowAt={rowAt}
        widths={sheet.widths}
        centerHeader
      />
    </>
  );
}

function SheetTabs({
  sheets,
  shown,
  onShow,
}: {
  sheets: readonly Sheet[];
  shown: string;
  onShow: (name: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="tablist"
      aria-label={t("spreadsheetPreview.sheets")}
      className="app-scrollbar flex shrink-0 gap-1 overflow-x-auto px-2 py-1 border-t border-border bg-[var(--surface-island-bg)]"
    >
      {sheets.map((sheet) => (
        <button
          key={sheet.name}
          type="button"
          role="tab"
          aria-selected={sheet.name === shown}
          onClick={() => onShow(sheet.name)}
          className={cn(
            "shrink-0 rounded px-2 py-0.5 text-app-ui-sm whitespace-nowrap",
            sheet.name === shown
              ? "bg-[var(--surface-backdrop-bg)] text-foreground font-medium"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {sheet.name}
        </button>
      ))}
    </div>
  );
}

function SpreadsheetStatus({ status }: { status: Status }) {
  const { t } = useTranslation();
  if (status.kind === "loading" || status.kind === "ready") {
    return <div className="flex-1" aria-busy />;
  }
  const title =
    status.kind === "too_large"
      ? t("spreadsheetPreview.too_large", { maxMb: MAX_READABLE_FILE_SIZE / (1024 * 1024) })
      : status.kind === "outside"
        ? t("spreadsheetPreview.outside_workspace")
        : status.kind === "no-workspace"
          ? t("imagePreview.workspace_not_found")
          : t("spreadsheetPreview.load_failed");
  return <EmptyState title={title} tone="status" className="flex-1 min-h-0" />;
}
