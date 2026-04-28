import { fileURLToPath } from "node:url";

import type { LspRange, LspSymbolKind, LspSymbolTag } from "../../../../../shared/src/contracts/editor/editor-bridge";
import { toWorkspaceRelativePath } from "../../workspace/files/workspace-files-paths";

export interface ProtocolPositionLike {
  line?: number;
  character?: number;
}

export interface ProtocolRangeLike {
  start?: ProtocolPositionLike;
  end?: ProtocolPositionLike;
}

export function mapProtocolRange(range: ProtocolRangeLike | undefined | null): LspRange {
  const startLine = finiteInteger(range?.start?.line);
  const startCharacter = finiteInteger(range?.start?.character);
  return {
    start: {
      line: startLine,
      character: startCharacter,
    },
    end: {
      line: finiteInteger(range?.end?.line, startLine),
      character: finiteInteger(range?.end?.character, startCharacter),
    },
  };
}

export function isProtocolRange(value: unknown): value is Required<ProtocolRangeLike> {
  return isRecord(value) && isRecord(value.start) && isRecord(value.end);
}

export function mapFileUriToWorkspacePath(
  workspaceRoot: string,
  uri: string,
): { uri: string; path: string | null } {
  if (!uri.startsWith("file:")) {
    return { uri, path: null };
  }

  try {
    return {
      uri,
      path: toWorkspaceRelativePath(workspaceRoot, fileURLToPath(uri)),
    };
  } catch {
    return { uri, path: null };
  }
}

export function mapSymbolKind(kind: number | undefined): LspSymbolKind {
  switch (kind) {
    case 1:
      return "file";
    case 2:
      return "module";
    case 3:
      return "namespace";
    case 4:
      return "package";
    case 5:
      return "class";
    case 6:
      return "method";
    case 7:
      return "property";
    case 8:
      return "field";
    case 9:
      return "constructor";
    case 10:
      return "enum";
    case 11:
      return "interface";
    case 12:
      return "function";
    case 13:
      return "variable";
    case 14:
      return "constant";
    case 15:
      return "string";
    case 16:
      return "number";
    case 17:
      return "boolean";
    case 18:
      return "array";
    case 19:
      return "object";
    case 20:
      return "key";
    case 21:
      return "null";
    case 22:
      return "enum-member";
    case 23:
      return "struct";
    case 24:
      return "event";
    case 25:
      return "operator";
    case 26:
      return "type-parameter";
    default:
      return "variable";
  }
}

export function mapSymbolTags(tags: readonly number[] | undefined | null): LspSymbolTag[] {
  return tags?.includes(1) ? ["deprecated"] : [];
}

export function finiteInteger(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : fallback;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
