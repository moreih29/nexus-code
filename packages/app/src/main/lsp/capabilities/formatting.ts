import type {
  DocumentFormattingParams,
  DocumentRangeFormattingParams,
} from "vscode-languageserver-protocol";

import type {
  LspDocumentFormattingRequest,
  LspDocumentFormattingResult,
  LspFormattingOptions,
  LspRangeFormattingRequest,
  LspRangeFormattingResult,
} from "../../../../../shared/src/contracts/editor/editor-bridge";
import { mapProtocolTextEdits } from "./edit-mapping";

export interface DocumentFormattingAdapterContext {
  request: LspDocumentFormattingRequest;
  path: string;
  uri: string;
  sendRequest(params: DocumentFormattingParams): Promise<unknown>;
}

export interface RangeFormattingAdapterContext {
  request: LspRangeFormattingRequest;
  path: string;
  uri: string;
  sendRequest(params: DocumentRangeFormattingParams): Promise<unknown>;
}

export interface LspFormattingCapabilityOptions {
  now: () => Date;
}

export class LspFormattingCapability {
  public constructor(private readonly options: LspFormattingCapabilityOptions) {}

  public async documentFormatting(
    context: DocumentFormattingAdapterContext,
  ): Promise<LspDocumentFormattingResult> {
    const response = await context.sendRequest(
      buildDocumentFormattingParams(context.request, context.uri),
    );

    return {
      type: "lsp-formatting/document/result",
      workspaceId: context.request.workspaceId,
      path: context.path,
      language: context.request.language,
      edits: mapProtocolTextEdits(response),
      formattedAt: this.timestamp(),
    };
  }

  public emptyDocumentResult(
    request: LspDocumentFormattingRequest,
    path: string,
  ): LspDocumentFormattingResult {
    return {
      type: "lsp-formatting/document/result",
      workspaceId: request.workspaceId,
      path,
      language: request.language,
      edits: [],
      formattedAt: this.timestamp(),
    };
  }

  public async rangeFormatting(
    context: RangeFormattingAdapterContext,
  ): Promise<LspRangeFormattingResult> {
    const response = await context.sendRequest(
      buildRangeFormattingParams(context.request, context.uri),
    );

    return {
      type: "lsp-formatting/range/result",
      workspaceId: context.request.workspaceId,
      path: context.path,
      language: context.request.language,
      edits: mapProtocolTextEdits(response),
      formattedAt: this.timestamp(),
    };
  }

  public emptyRangeResult(
    request: LspRangeFormattingRequest,
    path: string,
  ): LspRangeFormattingResult {
    return {
      type: "lsp-formatting/range/result",
      workspaceId: request.workspaceId,
      path,
      language: request.language,
      edits: [],
      formattedAt: this.timestamp(),
    };
  }

  private timestamp(): string {
    return this.options.now().toISOString();
  }
}

export function buildDocumentFormattingParams(
  request: LspDocumentFormattingRequest,
  uri: string,
): DocumentFormattingParams {
  return {
    textDocument: {
      uri,
    },
    options: mapFormattingOptions(request.options),
  };
}

export function buildRangeFormattingParams(
  request: LspRangeFormattingRequest,
  uri: string,
): DocumentRangeFormattingParams {
  return {
    textDocument: {
      uri,
    },
    range: request.range,
    options: mapFormattingOptions(request.options),
  };
}

function mapFormattingOptions(options: LspFormattingOptions): DocumentFormattingParams["options"] {
  return {
    tabSize: options.tabSize,
    insertSpaces: options.insertSpaces,
    trimTrailingWhitespace: options.trimTrailingWhitespace ?? undefined,
    insertFinalNewline: options.insertFinalNewline ?? undefined,
    trimFinalNewlines: options.trimFinalNewlines ?? undefined,
  };
}
