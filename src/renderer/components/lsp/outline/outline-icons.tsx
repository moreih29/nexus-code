import {
  Box,
  Braces,
  CircleDot,
  Component,
  FileCode,
  FunctionSquare,
  Hash,
  KeyRound,
  Layers,
  type LucideIcon,
  Package,
  Sigma,
  Tag,
  Variable,
} from "lucide-react";
import type { SymbolKind } from "../../../../shared/lsp-types";

const SYMBOL_ICON_BY_KIND: Partial<Record<SymbolKind, LucideIcon>> = {
  2: Package,
  3: Package,
  4: Package,
  5: Box,
  6: FunctionSquare,
  7: Layers,
  8: Variable,
  9: Component,
  10: Component,
  11: Component,
  12: FunctionSquare,
  13: Variable,
  14: Hash,
  15: Braces,
  16: Hash,
  17: FileCode,
  18: KeyRound,
  19: CircleDot,
  20: Component,
  21: Tag,
  22: Component,
  23: Sigma,
  24: Component,
  25: Component,
  26: Component,
};

export function iconForSymbolKind(kind: SymbolKind): LucideIcon {
  return SYMBOL_ICON_BY_KIND[kind] ?? FileCode;
}
