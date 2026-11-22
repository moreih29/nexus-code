import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { DiffHunk } from "../../../../packages/remote-protocol/src/rpc";
import { cn } from "../../utils/cn";

const ROW_HEIGHT = 24;

function patchRows(hunks: readonly DiffHunk[]) {
  const rows: { text: string; old?: number; next?: number; header?: true }[] = [];
  for (const hunk of hunks) {
    let old = hunk.oldStart;
    let next = hunk.newStart;
    rows.push({
      header: true,
      text: `@@ -${old},${hunk.oldLines} +${next},${hunk.newLines} @@`,
    });
    for (const text of hunk.lines) {
      const sign = text[0];
      rows.push({
        text,
        old: sign === "-" || sign === " " ? old++ : undefined,
        next: sign === "+" || sign === " " ? next++ : undefined,
      });
    }
  }
  return rows;
}

export function PeerPatchView({
  hunks,
  binary,
  permissionDenied,
  truncated,
  embedded = false,
}: {
  hunks: readonly DiffHunk[];
  binary?: boolean;
  permissionDenied?: boolean;
  truncated?: boolean;
  embedded?: boolean;
}) {
  const { t } = useTranslation();
  const scroll = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => patchRows(hunks), [hunks]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  return (
    <div className={cn("flex min-h-0 min-w-0 flex-col", !embedded && "flex-1")}>
      {(!embedded || truncated) && (
        <div
          role="status"
          className="shrink-0 border-b border-border px-2 py-1 text-app-ui-sm text-[var(--state-warning-fg)]"
        >
          {!embedded && t("peerWorkspace.gitPatchOnly")}
          {truncated && <div>{t("peerWorkspace.gitPatchTruncated")}</div>}
        </div>
      )}
      {(binary || permissionDenied) && (
        <div className="shrink-0 px-2 py-1 text-app-ui-sm text-muted-foreground">
          {t(binary ? "editor.binary_file" : "peerWorkspace.accessDenied")}
        </div>
      )}
      <div
        ref={scroll}
        className={cn("app-scrollbar min-h-0 overflow-auto", embedded ? "max-h-64" : "flex-1")}
      >
        <div className="relative min-w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map(({ index, key, start, size }) => {
            const row = rows[index];
            return (
              <div
                key={key}
                style={{ top: start, height: size }}
                className={cn(
                  "absolute flex min-w-full items-center gap-1.5 whitespace-pre px-2 font-mono text-app-ui-sm",
                  row.header && "bg-muted text-muted-foreground",
                  row.text.startsWith("+") && "bg-[var(--diff-added-bg)]",
                  row.text.startsWith("-") && "bg-[var(--diff-removed-bg)]",
                )}
              >
                <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">
                  {row.old}
                </span>
                <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">
                  {row.next}
                </span>
                <span>{row.text}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
