// Normalizers turn the raw JSON the LSP server returns into the shape the
// shared LSP schemas expect. Servers vary in how strictly they implement
// the spec — some return Hover.contents as a string, others as
// MarkupContent, others as the legacy MarkedString[]. Centralizing the
// reshape here keeps the host class free of branching per method.

import { z } from "zod";
import {
  CompletionItemSchema,
  DiagnosticSchema,
  DocumentSymbolSchema,
  type Location,
  LocationLinkSchema,
  LocationSchema,
  MarkupContentSchema,
  RangeSchema,
  SymbolInformationSchema,
  TextDocumentIdentifierSchema,
} from "../../../shared/lsp";
import { isObjectLike } from "./utils";

export function normalizeHoverResult(raw: unknown): unknown {
  if (!isObjectLike(raw)) return null;
  const contents = normalizeHoverContents(raw.contents);
  if (contents === null) return null;

  const range = RangeSchema.safeParse(raw.range);
  return range.success ? { contents, range: range.data } : { contents };
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
  const hierarchical = z.array(DocumentSymbolSchema).safeParse(raw);
  if (hierarchical.success) return hierarchical.data;

  // Servers that don't advertise (or ignore) hierarchical support fall back
  // to the legacy SymbolInformation[] shape per LSP spec. Convert each entry
  // into a flat DocumentSymbol so downstream consumers — which only know the
  // hierarchical schema — still get a usable outline. Parent/child links are
  // lost (SymbolInformation only carries containerName), but a flat outline
  // beats an empty one.
  const flat = z.array(SymbolInformationSchema).safeParse(raw);
  if (flat.success) {
    return flat.data.map((info) => ({
      name: info.name,
      kind: info.kind,
      tags: info.tags,
      deprecated: info.deprecated,
      range: info.location.range,
      selectionRange: info.location.range,
      children: [],
    }));
  }

  console.warn("[lsp-agent] textDocument/documentSymbol returned unrecognized shape", {
    hierarchicalIssues: hierarchical.error.issues,
    flatIssues: flat.error.issues,
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
    Array.isArray(raw) || !isObjectLike(raw) ? raw : (raw as { items?: unknown }).items;
  const items = Array.isArray(rawItems) ? rawItems : [];
  return items.flatMap((item) => {
    const parsed = CompletionItemSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

export function parsePublishDiagnostics(
  params: unknown,
): { uri: string; diagnostics: z.infer<typeof DiagnosticSchema>[] } | null {
  const parsed = z
    .object({
      uri: TextDocumentIdentifierSchema.shape.uri,
      diagnostics: z.array(z.unknown()).optional(),
    })
    .safeParse(params);
  if (!parsed.success) return null;

  return {
    uri: parsed.data.uri,
    diagnostics: (parsed.data.diagnostics ?? []).flatMap((diagnostic) => {
      const item = DiagnosticSchema.safeParse(diagnostic);
      return item.success ? [item.data] : [];
    }),
  };
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

function markedStringToMarkdown(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (!isObjectLike(raw) || !("value" in raw)) return "";

  const value = raw.value;
  if (typeof value !== "string") return "";

  const language = raw.language;
  if (typeof language === "string" && language.length > 0) {
    return `\`\`\`${language}\n${value}\n\`\`\``;
  }
  return value;
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
