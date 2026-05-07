// Pure, stateless result normalizers — transform raw LSP responses into typed shapes.

import { z } from "zod";
import {
  CompletionItemSchema,
  type Diagnostic,
  DiagnosticSchema,
  DocumentSymbolSchema,
  type Location,
  LocationLinkSchema,
  LocationSchema,
  MarkupContentSchema,
  RangeSchema,
  SymbolInformationSchema,
  TextDocumentIdentifierSchema,
} from "../../shared/lsp-types";

const PublishDiagnosticsParamsSchema = z.object({
  uri: TextDocumentIdentifierSchema.shape.uri,
  diagnostics: z.array(z.unknown()).optional(),
});

function markedStringToMarkdown(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (typeof raw !== "object" || raw === null || !("value" in raw)) return "";

  const value = (raw as { value?: unknown }).value;
  if (typeof value !== "string") return "";

  const language = (raw as { language?: unknown }).language;
  if (typeof language === "string" && language.length > 0) {
    return `\`\`\`${language}\n${value}\n\`\`\``;
  }
  return value;
}

function normalizeHoverContents(raw: unknown): unknown {
  const markup = MarkupContentSchema.safeParse(raw);
  if (markup.success) return markup.data;

  if (Array.isArray(raw)) {
    const text = raw.map(markedStringToMarkdown).filter(Boolean).join("\n\n");
    return text.length > 0 ? text : null;
  }

  if (typeof raw === "string") return raw;

  const marked = markedStringToMarkdown(raw);
  return marked.length > 0 ? marked : null;
}

export function normalizeHoverResult(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return null;
  const result = raw as { contents?: unknown; range?: unknown };
  const contents = normalizeHoverContents(result.contents);
  if (contents === null) return null;

  const range = RangeSchema.safeParse(result.range);
  return range.success ? { contents, range: range.data } : { contents };
}

function normalizeDefinitionItem(raw: unknown): Location | null {
  const location = LocationSchema.safeParse(raw);
  if (location.success) return location.data;

  const locationLink = LocationLinkSchema.safeParse(raw);
  if (locationLink.success) {
    return {
      uri: locationLink.data.targetUri,
      range: locationLink.data.targetSelectionRange,
    };
  }

  return null;
}

export function normalizeDefinitionResult(raw: unknown): unknown {
  if (!raw) return [];
  const items = Array.isArray(raw) ? raw : [raw];
  return items.flatMap((item) => {
    const normalized = normalizeDefinitionItem(item);
    return normalized ? [normalized] : [];
  });
}

export function normalizeDocumentHighlightResult(raw: unknown): unknown {
  return raw ?? [];
}

export function normalizeDocumentSymbolResult(raw: unknown): unknown {
  const parsed = z.array(DocumentSymbolSchema).safeParse(raw);
  if (parsed.success) return parsed.data;

  console.warn("[lsp-manager] textDocument/documentSymbol returned non-hierarchical symbols", {
    issues: parsed.error.issues,
  });
  return [];
}

export function normalizeWorkspaceSymbolResult(raw: unknown): unknown {
  if (!raw) return [];
  const items = Array.isArray(raw) ? raw : [];
  return items.flatMap((item) => {
    const parsed = SymbolInformationSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

export function normalizeCompletionResult(raw: unknown): unknown {
  if (!raw) return [];
  const rawItems =
    Array.isArray(raw) || typeof raw !== "object" || raw === null
      ? raw
      : (raw as { items?: unknown }).items;
  const items = Array.isArray(rawItems) ? rawItems : [];
  return items.flatMap((item) => {
    const parsed = CompletionItemSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

export function parsePublishDiagnostics(
  params: unknown,
): { uri: string; diagnostics: Diagnostic[] } | null {
  const parsed = PublishDiagnosticsParamsSchema.safeParse(params);
  if (!parsed.success) return null;

  return {
    uri: parsed.data.uri,
    diagnostics: (parsed.data.diagnostics ?? []).flatMap((diagnostic) => {
      const item = DiagnosticSchema.safeParse(diagnostic);
      return item.success ? [item.data] : [];
    }),
  };
}
