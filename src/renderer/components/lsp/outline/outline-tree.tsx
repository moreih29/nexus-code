import { useEffect, useMemo, useState } from "react";
import { cn } from "@/utils/cn";
import type { DocumentSymbol, Position } from "../../../../shared/lsp";
import { iconForSymbolKind } from "./outline-icons";
import {
  buildOutlineRows,
  collectExpandableIds,
  currentSymbolId,
  reduceOutlineKeyboard,
  type OutlineKeyboardResult,
  type OutlineKeyboardState,
  type OutlineRow,
} from "./outline-tree-keyboard";

export type { OutlineRow, OutlineKeyboardState, OutlineKeyboardResult };
export { collectExpandableIds, buildOutlineRows, currentSymbolId, reduceOutlineKeyboard };

const ROW_HEIGHT_PX = 24;
const OUTLINE_INDENT_BASE_PX = 8;
const OUTLINE_INDENT_STEP_PX = 14;

interface OutlineTreeProps {
  symbols: DocumentSymbol[];
  cursorPosition?: Position | null;
  onSelectSymbol?: (symbol: DocumentSymbol) => void;
}

export function OutlineTree({ symbols, cursorPosition = null, onSelectSymbol }: OutlineTreeProps) {
  const [expandedIds, setExpandedIds] = useState(() => collectExpandableIds(symbols));
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const nextExpandedIds = collectExpandableIds(symbols);
    const nextRows = buildOutlineRows(symbols, nextExpandedIds);
    setExpandedIds(nextExpandedIds);
    setActiveId(nextRows[0]?.id ?? null);
  }, [symbols]);

  const rows = useMemo(() => buildOutlineRows(symbols, expandedIds), [symbols, expandedIds]);
  const cursorSymbolId = useMemo(
    () => currentSymbolId(symbols, cursorPosition),
    [symbols, cursorPosition],
  );
  const selectedId = activeId ?? rows[0]?.id ?? null;

  return (
    <div
      role="tree"
      aria-label="Document outline"
      tabIndex={0}
      onKeyDown={(event) => {
        const result = reduceOutlineKeyboard(event.key, rows, {
          activeId: selectedId,
          expandedIds,
        });
        if (!result.handled) return;
        event.preventDefault();
        setActiveId(result.activeId);
        setExpandedIds(result.expandedIds);
      }}
      className="h-full overflow-auto app-scrollbar focus:outline-none"
    >
      {rows.map((row) => {
        const Icon = iconForSymbolKind(row.symbol.kind);
        const isSelected = row.id === selectedId;
        const isCurrent = row.id === cursorSymbolId;

        return (
          <button
            key={row.id}
            type="button"
            role="treeitem"
            aria-level={row.depth + 1}
            aria-expanded={row.hasChildren ? expandedIds.has(row.id) : undefined}
            aria-selected={isSelected}
            aria-current={isCurrent ? "location" : undefined}
            data-outline-id={row.id}
            data-current={isCurrent || undefined}
            onClick={() => {
              setActiveId(row.id);
              onSelectSymbol?.(row.symbol);
            }}
            title={
              row.symbol.detail ? `${row.symbol.name} — ${row.symbol.detail}` : row.symbol.name
            }
            style={{
              paddingLeft: OUTLINE_INDENT_BASE_PX + row.depth * OUTLINE_INDENT_STEP_PX,
              height: ROW_HEIGHT_PX,
            }}
            className={cn(
              "flex w-full items-center border-l-2 border-l-transparent text-left text-app-body select-none",
              "text-muted-foreground hover:bg-frosted-veil-strong hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-mist-border-focus focus-visible:ring-inset",
              isSelected && "bg-frosted-veil border-l-mist-border-focus text-foreground",
              isCurrent &&
                !isSelected &&
                "bg-frosted-veil-strong border-l-mist-border-focus text-foreground",
            )}
          >
            <span className="inline-flex size-3.5 shrink-0 items-center justify-center text-stone-gray">
              {row.hasChildren ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "text-[10px] leading-none transition-transform",
                    expandedIds.has(row.id) && "rotate-90",
                  )}
                >
                  ›
                </span>
              ) : null}
            </span>
            <Icon
              className="ml-1 size-3.5 shrink-0 text-stone-gray"
              strokeWidth={1.5}
              aria-hidden
            />
            <span className="ml-1.5 min-w-0 truncate">{row.symbol.name}</span>
            {row.symbol.detail ? (
              <span className="ml-2 min-w-0 truncate text-stone-gray">{row.symbol.detail}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
