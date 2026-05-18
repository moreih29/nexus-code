import { fileUriToAbsolutePath } from "../../../shared/fs/file-uri";
import type { OpenEditorOptions } from "../../services/editor";
import { revealEditorAt } from "../../services/editor/tabs";
import {
  searchWorkspaceSymbols,
  symbolUriToString,
  type WorkspaceSymbolEntry,
  workspaceSymbolDedupeKey,
} from "../../services/lsp/workspace-symbol-registry";
import { relPath } from "../../utils/path";
import type { PaletteAcceptContext, PaletteItem, PaletteSource } from "../ui/palette/types";

export interface WorkspaceSymbolPaletteItem extends PaletteItem {
  symbol: WorkspaceSymbolEntry;
  filePath: string | null;
}

interface CreateWorkspaceSymbolPaletteSourceInput {
  workspaceId: string;
  workspaceRoot: string;
  search?: typeof searchWorkspaceSymbols;
  /**
   * Editor open + selection seam — defaults to `revealEditorAt`. Tests
   * inject a stub to assert the open + selection arguments without
   * touching the real tab/registry stores.
   */
  openEditor?: typeof revealEditorAt;
}

const SYMBOL_KIND_LABELS: Record<number, string> = {
  0: "File",
  1: "Module",
  2: "Namespace",
  3: "Package",
  4: "Class",
  5: "Method",
  6: "Property",
  7: "Field",
  8: "Constructor",
  9: "Enum",
  10: "Interface",
  11: "Function",
  12: "Variable",
  13: "Constant",
  14: "String",
  15: "Number",
  16: "Boolean",
  17: "Array",
  18: "Object",
  19: "Key",
  20: "Null",
  21: "Enum member",
  22: "Struct",
  23: "Event",
  24: "Operator",
  25: "Type parameter",
};

export function createWorkspaceSymbolPaletteSource({
  workspaceId,
  workspaceRoot,
  search = searchWorkspaceSymbols,
  openEditor = revealEditorAt,
}: CreateWorkspaceSymbolPaletteSourceInput): PaletteSource<WorkspaceSymbolPaletteItem> {
  return {
    id: "workspace-symbols",
    title: "Go to Symbol in Workspace",
    placeholder: "Search workspace symbols",
    emptyQueryMessage: "Type to search",
    noResultsMessage: "No workspace symbols found.",
    async search(query, signal) {
      const symbols = await search({ workspaceId, query, signal });
      return symbols.map((symbol) => workspaceSymbolToPaletteItem(symbol, workspaceRoot));
    },
    accept(item, context) {
      if (!item.filePath) return;
      openEditor(
        { workspaceId, filePath: item.filePath },
        { ...openOptionsForContext(context), selection: item.symbol.location.range },
      );
    },
  };
}

function workspaceSymbolToPaletteItem(
  symbol: WorkspaceSymbolEntry,
  workspaceRoot: string,
): WorkspaceSymbolPaletteItem {
  const uri = symbolUriToString(symbol.location.uri);
  const filePath = fileUriToAbsolutePath(uri);
  const pathLabel = filePath ? relPath(filePath, workspaceRoot) : uri;
  const locationLabel = `${pathLabel}:${symbol.location.range.startLineNumber}:${symbol.location.range.startColumn}`;
  const container = symbol.containerName ? `${symbol.containerName} · ` : "";
  const kindLabel = SYMBOL_KIND_LABELS[symbol.kind] ?? "Symbol";

  return {
    id: workspaceSymbolDedupeKey(symbol),
    label: symbol.name,
    detail: `${container}${locationLabel}`,
    description: pathLabel,
    kindLabel,
    ariaLabel: `${symbol.name}, ${kindLabel}, ${locationLabel}`,
    tooltip: filePath ?? uri,
    symbol,
    filePath,
  };
}

function openOptionsForContext(context?: PaletteAcceptContext): OpenEditorOptions | undefined {
  if (context?.mode === "side") {
    return { newSplit: { orientation: "horizontal", side: "after" } };
  }
  return undefined;
}
