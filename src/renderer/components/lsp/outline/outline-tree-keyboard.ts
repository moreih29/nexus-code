import type { DocumentSymbol, Position } from "../../../../shared/lsp-types";

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
