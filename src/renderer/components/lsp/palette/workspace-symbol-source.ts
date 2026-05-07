import { fileUriToAbsolutePath } from "../../../../shared/file-uri";
import { type OpenEditorOptions, openOrRevealEditor } from "../../../services/editor";
import { requestEditorReveal } from "../../../services/editor/pending-reveal";
import {
  searchWorkspaceSymbols,
  symbolUriToString,
  type WorkspaceSymbolEntry,
  workspaceSymbolDedupeKey,
} from "../../../services/lsp/workspace-symbol-registry";
import { relPath } from "../../../utils/path";
import type { PaletteAcceptContext, PaletteItem, PaletteSource } from "./types";

export interface WorkspaceSymbolPaletteItem extends PaletteItem {
  symbol: WorkspaceSymbolEntry;
  filePath: string | null;
}

interface CreateWorkspaceSymbolPaletteSourceInput {
  workspaceId: string;
  workspaceRoot: string;
  search?: typeof searchWorkspaceSymbols;
  openEditor?: typeof openOrRevealEditor;
  revealEditor?: typeof requestEditorReveal;
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
  openEditor = openOrRevealEditor,
  revealEditor = requestEditorReveal,
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
      const openOptions = openOptionsForContext(context);
      openEditor({ workspaceId, filePath: item.filePath }, openOptions);
      revealEditor({ workspaceId, filePath: item.filePath, range: item.symbol.location.range });
    },
  };
}

export function workspaceSymbolToPaletteItem(
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

function openOptionsForContext(context: PaletteAcceptContext): OpenEditorOptions | undefined {
  if (context.mode === "side") {
    return { newSplit: { orientation: "horizontal", side: "after" } };
  }
  return undefined;
}
