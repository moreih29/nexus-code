import { z } from "zod";
import { createLogger } from "../../../shared/log/main";
import {
  type CompletionItem,
  CompletionItemSchema,
  type CompletionList,
  DiagnosticSchema,
  DocumentSymbolSchema,
  type Location,
  LocationLinkSchema,
  LocationSchema,
  MarkupContentSchema,
  RangeSchema,
  SignatureInformationSchema,
  SymbolInformationSchema,
  TextDocumentIdentifierSchema,
} from "../../../shared/lsp";
import { isObjectLike } from "./utils";

const log = createLogger("lsp-normalizers");

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

export function normalizeSignatureHelpResult(raw: unknown): unknown {
  if (!isObjectLike(raw) || !Array.isArray(raw.signatures)) return null;
  const signatures = raw.signatures.flatMap((signature) => {
    if (!isObjectLike(signature)) return [];
    const parsed = SignatureInformationSchema.safeParse({
      ...withoutNulls(signature),
      ...(signature.activeParameter === null ? { activeParameter: null } : {}),
      ...(Array.isArray(signature.parameters)
        ? {
            parameters: signature.parameters.map((parameter) =>
              isObjectLike(parameter) ? withoutNulls(parameter) : parameter,
            ),
          }
        : {}),
    });
    return parsed.success ? [parsed.data] : [];
  });
  if (signatures.length === 0) return null;
  return {
    signatures,
    ...(typeof raw.activeSignature === "number" ? { activeSignature: raw.activeSignature } : {}),
    ...(typeof raw.activeParameter === "number" || raw.activeParameter === null
      ? { activeParameter: raw.activeParameter }
      : {}),
  };
}

function withoutNulls(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== null));
}

export function normalizeDocumentHighlightResult(raw: unknown): unknown {
  return raw ?? [];
}

export function normalizeDocumentSymbolResult(raw: unknown): unknown {
  const hierarchical = z.array(DocumentSymbolSchema).safeParse(raw);
  if (hierarchical.success) return hierarchical.data;

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

  log.warn(
    `textDocument/documentSymbol returned unrecognized shape (hierarchicalIssues=${hierarchical.error.issues.length}, flatIssues=${flat.error.issues.length})`,
  );
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

export function normalizeCompletionResult(raw: unknown): CompletionList {
  const isList = isObjectLike(raw) && !Array.isArray(raw);
  const rawItems = isList ? raw.items : raw;
  const items = Array.isArray(rawItems) ? rawItems : [];
  return {
    isIncomplete: isList && raw.isIncomplete === true,
    items: items.flatMap((item) => {
      const normalized = normalizeCompletionItem(item);
      return normalized ? [normalized] : [];
    }),
  };
}

export function normalizeCompletionItem(raw: unknown): CompletionItem | null {
  if (!isObjectLike(raw) || typeof raw.label !== "string") return null;
  const item: Record<string, unknown> = { label: raw.label };
  for (const [key, schema] of Object.entries(CompletionItemSchema.shape)) {
    if (key === "label" || raw[key] === undefined || raw[key] === null) continue;
    const parsed = schema.safeParse(raw[key]);
    if (parsed.success) item[key] = parsed.data;
  }
  return item as CompletionItem;
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
