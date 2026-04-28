import type {
  DocumentSymbol as ProtocolDocumentSymbol,
  DocumentSymbolParams,
  SymbolInformation as ProtocolSymbolInformation,
} from "vscode-languageserver-protocol";

import type {
  LspDocumentSymbol,
  LspDocumentSymbolItem,
  LspDocumentSymbolsRequest,
  LspDocumentSymbolsResult,
  LspSymbolInformation,
} from "../../../../../shared/src/contracts/editor/editor-bridge";
import { isProtocolLocation, mapLocation } from "./definition";
import {
  isProtocolRange,
  isRecord,
  mapProtocolRange,
  mapSymbolKind,
  mapSymbolTags,
} from "./read-mapping";

export interface DocumentSymbolsAdapterContext {
  request: LspDocumentSymbolsRequest;
  path: string;
  uri: string;
  workspaceRoot: string;
  sendRequest(params: DocumentSymbolParams): Promise<unknown>;
}

export interface LspDocumentSymbolsCapabilityOptions {
  now: () => Date;
}

export class LspDocumentSymbolsCapability {
  public constructor(private readonly options: LspDocumentSymbolsCapabilityOptions) {}

  public async documentSymbols(
    context: DocumentSymbolsAdapterContext,
  ): Promise<LspDocumentSymbolsResult> {
    const response = await context.sendRequest(buildDocumentSymbolsParams(context.uri));

    return {
      type: "lsp-document-symbols/read/result",
      workspaceId: context.request.workspaceId,
      path: context.path,
      language: context.request.language,
      symbols: mapDocumentSymbolsResponse(response, context.workspaceRoot),
      readAt: this.timestamp(),
    };
  }

  public emptyResult(
    request: LspDocumentSymbolsRequest,
    path: string,
  ): LspDocumentSymbolsResult {
    return {
      type: "lsp-document-symbols/read/result",
      workspaceId: request.workspaceId,
      path,
      language: request.language,
      symbols: [],
      readAt: this.timestamp(),
    };
  }

  private timestamp(): string {
    return this.options.now().toISOString();
  }
}

export function buildDocumentSymbolsParams(uri: string): DocumentSymbolParams {
  return {
    textDocument: {
      uri,
    },
  };
}

export function mapDocumentSymbolsResponse(
  response: unknown,
  workspaceRoot: string,
): LspDocumentSymbolItem[] {
  if (!Array.isArray(response)) {
    return [];
  }

  return response.flatMap((item) => {
    if (isProtocolSymbolInformation(item)) {
      return [mapSymbolInformation(item, workspaceRoot)];
    }

    if (isProtocolDocumentSymbol(item)) {
      return [mapDocumentSymbol(item)];
    }

    return [];
  });
}

export function mapDocumentSymbol(symbol: ProtocolDocumentSymbol): LspDocumentSymbol {
  return {
    type: "document-symbol",
    name: symbol.name,
    detail: symbol.detail ?? null,
    kind: mapSymbolKind(symbol.kind),
    tags: mapSymbolTags(symbol.tags),
    range: mapProtocolRange(symbol.range),
    selectionRange: mapProtocolRange(symbol.selectionRange),
    children: (symbol.children ?? []).filter(isProtocolDocumentSymbol).map(mapDocumentSymbol),
  };
}

export function mapSymbolInformation(
  symbol: ProtocolSymbolInformation,
  workspaceRoot: string,
): LspSymbolInformation {
  return {
    type: "symbol-information",
    name: symbol.name,
    kind: mapSymbolKind(symbol.kind),
    tags: mapSymbolTags(symbol.tags),
    containerName: symbol.containerName ?? null,
    location: mapLocation(symbol.location, workspaceRoot),
  };
}

export function isProtocolDocumentSymbol(value: unknown): value is ProtocolDocumentSymbol {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.kind === "number" &&
    isProtocolRange(value.range) &&
    isProtocolRange(value.selectionRange)
  );
}

export function isProtocolSymbolInformation(value: unknown): value is ProtocolSymbolInformation {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.kind === "number" &&
    isProtocolLocation(value.location)
  );
}
