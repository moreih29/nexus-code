import type { ReferenceParams } from "vscode-languageserver-protocol";

import type {
  LspLocation,
  LspReferencesRequest,
  LspReferencesResult,
} from "../../../../../shared/src/contracts/editor/editor-bridge";
import { isProtocolLocation, mapLocation } from "./definition";

export interface ReferencesAdapterContext {
  request: LspReferencesRequest;
  path: string;
  uri: string;
  workspaceRoot: string;
  sendRequest(params: ReferenceParams): Promise<unknown>;
}

export interface LspReferencesCapabilityOptions {
  now: () => Date;
}

export class LspReferencesCapability {
  public constructor(private readonly options: LspReferencesCapabilityOptions) {}

  public async references(
    context: ReferencesAdapterContext,
  ): Promise<LspReferencesResult> {
    const response = await context.sendRequest(
      buildReferencesParams(context.request, context.uri),
    );

    return {
      type: "lsp-references/read/result",
      workspaceId: context.request.workspaceId,
      path: context.path,
      language: context.request.language,
      locations: mapReferencesResponse(response, context.workspaceRoot),
      readAt: this.timestamp(),
    };
  }

  public emptyResult(
    request: LspReferencesRequest,
    path: string,
  ): LspReferencesResult {
    return {
      type: "lsp-references/read/result",
      workspaceId: request.workspaceId,
      path,
      language: request.language,
      locations: [],
      readAt: this.timestamp(),
    };
  }

  private timestamp(): string {
    return this.options.now().toISOString();
  }
}

export function buildReferencesParams(
  request: LspReferencesRequest,
  uri: string,
): ReferenceParams {
  return {
    textDocument: {
      uri,
    },
    position: request.position,
    context: {
      includeDeclaration: request.includeDeclaration === true,
    },
  };
}

export function mapReferencesResponse(
  response: unknown,
  workspaceRoot: string,
): LspLocation[] {
  if (!Array.isArray(response)) {
    return [];
  }

  return response
    .filter(isProtocolLocation)
    .map((location) => mapLocation(location, workspaceRoot));
}
