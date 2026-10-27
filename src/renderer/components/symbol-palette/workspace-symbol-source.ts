import i18next from "i18next";
import { fileUriToAbsolutePath } from "../../../shared/fs/file-uri";
import type { OpenEditorOptions } from "../../services/editor";
import { revealEditorAt } from "../../services/editor/tabs";
import {
  searchWorkspaceSymbols,
  symbolUriToString,
  type WorkspaceSymbolEntry,
  workspaceSymbolDedupeKey,
} from "../../services/lsp-ux/workspace-symbol-registry";
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

/** LSP SymbolKind (0-based, as Monaco numbers it) → common:palette.symbol_kind key. */
const SYMBOL_KIND_KEYS: Record<number, string> = {
  0: "file",
  1: "module",
  2: "namespace",
  3: "package",
  4: "class",
  5: "method",
  6: "property",
  7: "field",
  8: "constructor",
  9: "enum",
  10: "interface",
  11: "function",
  12: "variable",
  13: "constant",
  14: "string",
  15: "number",
  16: "boolean",
  17: "array",
  18: "object",
  19: "key",
  20: "null",
  21: "enum_member",
  22: "struct",
  23: "event",
  24: "operator",
  25: "type_parameter",
};

export function createWorkspaceSymbolPaletteSource({
  workspaceId,
  workspaceRoot,
  search = searchWorkspaceSymbols,
  openEditor = revealEditorAt,
}: CreateWorkspaceSymbolPaletteSourceInput): PaletteSource<WorkspaceSymbolPaletteItem> {
  const t = i18next.t.bind(i18next);
  return {
    id: "workspace-symbols",
    title: t("common:palette.go_to_symbol"),
    placeholder: t("common:palette.search_symbols"),
    emptyQueryMessage: t("common:palette.type_to_search"),
    noResultsMessage: t("common:palette.no_results"),
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
  const kindKey = SYMBOL_KIND_KEYS[symbol.kind];
  const kindLabel = i18next.t(
    kindKey ? `common:palette.symbol_kind.${kindKey}` : "common:palette.symbol_fallback",
  );

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
