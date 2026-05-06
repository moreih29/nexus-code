import { useEffect, useMemo, useState } from "react";
import { cn } from "@/utils/cn";
import type { DocumentSymbol, Position } from "../../../../shared/lsp-types";
import { iconForSymbolKind } from "./outline-icons";

const ROW_HEIGHT_PX = 24;

export interface OutlineRow {
  id: string;
  parentId: string | null;
  symbol: DocumentSymbol;
  depth: number;
  indexPath: number[];
  hasChildren: boolean;
}

export interface OutlineKeyboardState {
  activeId: string | null;
  expandedIds: Set<string>;
}

export interface OutlineKeyboardResult extends OutlineKeyboardState {
  handled: boolean;
}

function outlineId(indexPath: number[]): string {
  return indexPath.join(".");
}

function childSymbols(symbol: DocumentSymbol): DocumentSymbol[] {
  return symbol.children ?? [];
}

export function collectExpandableIds(symbols: DocumentSymbol[]): Set<string> {
  const expandedIds = new Set<string>();

  function visit(items: DocumentSymbol[], pathPrefix: number[]): void {
    items.forEach((symbol, index) => {
      const indexPath = [...pathPrefix, index];
      const children = childSymbols(symbol);
      if (children.length > 0) {
        expandedIds.add(outlineId(indexPath));
        visit(children, indexPath);
      }
    });
  }

  visit(symbols, []);
  return expandedIds;
}

export function buildOutlineRows(
  symbols: DocumentSymbol[],
  expandedIds: ReadonlySet<string>,
): OutlineRow[] {
  const rows: OutlineRow[] = [];

  function visit(
    items: DocumentSymbol[],
    depth: number,
    parentId: string | null,
    pathPrefix: number[],
  ) {
    items.forEach((symbol, index) => {
      const indexPath = [...pathPrefix, index];
      const id = outlineId(indexPath);
      const children = childSymbols(symbol);
      rows.push({
        id,
        parentId,
        symbol,
        depth,
        indexPath,
        hasChildren: children.length > 0,
      });
      if (children.length > 0 && expandedIds.has(id)) {
        visit(children, depth + 1, id, indexPath);
      }
    });
  }

  visit(symbols, 0, null, []);
  return rows;
}

function positionInRange(position: Position, symbol: DocumentSymbol): boolean {
  const { start, end } = symbol.range;
  const afterStart =
    position.line > start.line ||
    (position.line === start.line && position.character >= start.character);
  const beforeEnd =
    position.line < end.line || (position.line === end.line && position.character <= end.character);
  return afterStart && beforeEnd;
}

export function currentSymbolId(
  symbols: DocumentSymbol[],
  position: Position | null,
): string | null {
  if (!position) return null;

  const cursor = position;
  let match: string | null = null;

  function visit(items: DocumentSymbol[], pathPrefix: number[]): void {
    items.forEach((symbol, index) => {
      if (!positionInRange(cursor, symbol)) return;
      const indexPath = [...pathPrefix, index];
      match = outlineId(indexPath);
      visit(childSymbols(symbol), indexPath);
    });
  }

  visit(symbols, []);
  return match;
}

export function reduceOutlineKeyboard(
  key: string,
  rows: OutlineRow[],
  state: OutlineKeyboardState,
): OutlineKeyboardResult {
  if (rows.length === 0) return { ...state, handled: false };

  const currentIndex = Math.max(
    0,
    state.activeId ? rows.findIndex((row) => row.id === state.activeId) : 0,
  );
  const currentRow = rows[currentIndex] ?? rows[0];
  const expandedIds = new Set(state.expandedIds);

  if (key === "ArrowDown") {
    const nextRow = rows[Math.min(rows.length - 1, currentIndex + 1)] ?? currentRow;
    return { activeId: nextRow.id, expandedIds, handled: true };
  }

  if (key === "ArrowUp") {
    const nextRow = rows[Math.max(0, currentIndex - 1)] ?? currentRow;
    return { activeId: nextRow.id, expandedIds, handled: true };
  }

  if (key === "ArrowRight") {
    if (!currentRow.hasChildren) return { activeId: currentRow.id, expandedIds, handled: true };
    if (!expandedIds.has(currentRow.id)) {
      expandedIds.add(currentRow.id);
      return { activeId: currentRow.id, expandedIds, handled: true };
    }
    const nextRow = rows[currentIndex + 1];
    if (nextRow?.parentId === currentRow.id) {
      return { activeId: nextRow.id, expandedIds, handled: true };
    }
    return { activeId: currentRow.id, expandedIds, handled: true };
  }

  if (key === "ArrowLeft") {
    if (currentRow.hasChildren && expandedIds.has(currentRow.id)) {
      expandedIds.delete(currentRow.id);
      return { activeId: currentRow.id, expandedIds, handled: true };
    }
    if (currentRow.parentId) {
      return { activeId: currentRow.parentId, expandedIds, handled: true };
    }
    return { activeId: currentRow.id, expandedIds, handled: true };
  }

  return { ...state, handled: false };
}

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
            style={{ paddingLeft: 8 + row.depth * 14, height: ROW_HEIGHT_PX }}
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
