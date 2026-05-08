// LSP capability negotiation helpers — pure functions over ServerCapabilities.

import {
  type ServerCapabilities,
  ServerCapabilitiesSchema,
  TextDocumentSyncKind,
  type TextDocumentSyncKind as TextDocumentSyncKindValue,
} from "../../../shared/lsp";
import { isObjectLike } from "./json-rpc-codec";

export function initializeResultCapabilities(result: unknown): ServerCapabilities {
  if (!isObjectLike(result)) return {};

  const parsed = ServerCapabilitiesSchema.safeParse(result.capabilities);
  return parsed.success ? parsed.data : {};
}

function textDocumentSyncCapability(
  capabilities: ServerCapabilities,
): number | Record<string, unknown> | undefined {
  const value = capabilities.textDocumentSync;
  if (typeof value === "number" || isObjectLike(value)) return value;
  return undefined;
}

function validTextDocumentSyncKind(value: unknown): TextDocumentSyncKindValue | null {
  if (
    value === TextDocumentSyncKind.None ||
    value === TextDocumentSyncKind.Full ||
    value === TextDocumentSyncKind.Incremental
  ) {
    return value;
  }
  return null;
}

export function negotiatedTextDocumentSyncKind(
  capabilities: ServerCapabilities,
): TextDocumentSyncKindValue {
  const sync = textDocumentSyncCapability(capabilities);
  const numeric = validTextDocumentSyncKind(sync);
  if (numeric !== null) return numeric;
  if (isObjectLike(sync))
    return validTextDocumentSyncKind(sync.change) ?? TextDocumentSyncKind.None;
  return TextDocumentSyncKind.None;
}

export function negotiatedTextDocumentOpenClose(capabilities: ServerCapabilities): boolean {
  const sync = textDocumentSyncCapability(capabilities);
  const numeric = validTextDocumentSyncKind(sync);
  if (numeric !== null) return numeric !== TextDocumentSyncKind.None;
  return isObjectLike(sync) && sync.openClose === true;
}

export function negotiatedTextDocumentSave(capabilities: ServerCapabilities): {
  supported: boolean;
  includeText: boolean;
} {
  const sync = textDocumentSyncCapability(capabilities);
  if (!isObjectLike(sync)) return { supported: false, includeText: false };

  const save = sync.save;
  if (save === true) return { supported: true, includeText: false };
  if (isObjectLike(save)) {
    return { supported: true, includeText: save.includeText === true };
  }
  return { supported: false, includeText: false };
}
