import type {
  DefinitionParams,
  Location as ProtocolLocation,
  LocationLink as ProtocolLocationLink,
} from "vscode-languageserver-protocol";

import type {
  LspDefinitionRequest,
  LspDefinitionResult,
  LspDefinitionTarget,
  LspLocation,
  LspLocationLink,
} from "../../../../../shared/src/contracts/editor/editor-bridge";
import {
  isProtocolRange,
  isRecord,
  mapFileUriToWorkspacePath,
  mapProtocolRange,
} from "./read-mapping";

export interface DefinitionAdapterContext {
  request: LspDefinitionRequest;
  path: string;
  uri: string;
  workspaceRoot: string;
  sendRequest(params: DefinitionParams): Promise<unknown>;
}

export interface LspDefinitionCapabilityOptions {
  now: () => Date;
}

export class LspDefinitionCapability {
  public constructor(private readonly options: LspDefinitionCapabilityOptions) {}

  public async definition(
    context: DefinitionAdapterContext,
  ): Promise<LspDefinitionResult> {
    const response = await context.sendRequest(
      buildDefinitionParams(context.request, context.uri),
    );

    return {
      type: "lsp-definition/read/result",
      workspaceId: context.request.workspaceId,
      path: context.path,
      language: context.request.language,
      targets: mapDefinitionResponse(response, context.workspaceRoot),
      readAt: this.timestamp(),
    };
  }

  public emptyResult(
    request: LspDefinitionRequest,
    path: string,
  ): LspDefinitionResult {
    return {
      type: "lsp-definition/read/result",
      workspaceId: request.workspaceId,
      path,
      language: request.language,
      targets: [],
      readAt: this.timestamp(),
    };
  }

  private timestamp(): string {
    return this.options.now().toISOString();
  }
}

export function buildDefinitionParams(
  request: LspDefinitionRequest,
  uri: string,
): DefinitionParams {
  return {
    textDocument: {
      uri,
    },
    position: request.position,
  };
}

export function mapDefinitionResponse(
  response: unknown,
  workspaceRoot: string,
): LspDefinitionTarget[] {
  if (!response) {
    return [];
  }

  const items = Array.isArray(response) ? response : [response];
  return items.flatMap((item) => {
    if (isProtocolLocationLink(item)) {
      return [
        {
          type: "location-link",
          ...mapLocationLink(item, workspaceRoot),
        },
      ];
    }

    if (isProtocolLocation(item)) {
      return [
        {
          type: "location",
          ...mapLocation(item, workspaceRoot),
        },
      ];
    }

    return [];
  });
}

export function mapLocation(
  location: ProtocolLocation,
  workspaceRoot: string,
): LspLocation {
  const target = mapFileUriToWorkspacePath(workspaceRoot, location.uri);
  return {
    uri: target.uri,
    path: target.path,
    range: mapProtocolRange(location.range),
  };
}

export function mapLocationLink(
  locationLink: ProtocolLocationLink,
  workspaceRoot: string,
): LspLocationLink {
  const target = mapFileUriToWorkspacePath(workspaceRoot, locationLink.targetUri);
  return {
    originSelectionRange: isProtocolRange(locationLink.originSelectionRange)
      ? mapProtocolRange(locationLink.originSelectionRange)
      : null,
    targetUri: target.uri,
    targetPath: target.path,
    targetRange: mapProtocolRange(locationLink.targetRange),
    targetSelectionRange: mapProtocolRange(locationLink.targetSelectionRange),
  };
}

export function isProtocolLocation(value: unknown): value is ProtocolLocation {
  return isRecord(value) && typeof value.uri === "string" && isProtocolRange(value.range);
}

export function isProtocolLocationLink(value: unknown): value is ProtocolLocationLink {
  return (
    isRecord(value) &&
    typeof value.targetUri === "string" &&
    isProtocolRange(value.targetRange) &&
    isProtocolRange(value.targetSelectionRange)
  );
}
