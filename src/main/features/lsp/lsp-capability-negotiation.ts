// Capability negotiation reads the server's initialize result and decides
// whether each text-document lifecycle notification is worth sending. The
// helpers here are intentionally pure functions so the host class only
// needs to ask "should I send this?" and not duplicate the schema dance.

import {
  type ServerCapabilities,
  TextDocumentSyncKind,
  type TextDocumentSyncKind as TextDocumentSyncKindValue,
} from "../../../shared/lsp";
import { isObjectLike } from "./lsp-utils";

export function capabilityValueIsSupported(value: unknown): boolean {
  if (value === false || value === null || value === undefined) return false;
  if (typeof value === "number") return value !== 0;
  return Boolean(value);
}

export function negotiatedTextDocumentSyncKind(
  capabilities: ServerCapabilities,
): TextDocumentSyncKindValue {
  const sync = textDocumentSyncCapability(capabilities);
  const numeric = validTextDocumentSyncKind(sync);
  if (numeric !== null) return numeric;
  if (isObjectLike(sync)) {
    return validTextDocumentSyncKind(sync.change) ?? TextDocumentSyncKind.None;
  }
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
