import type {
  PrepareRenameParams,
  RenameParams,
} from "vscode-languageserver-protocol";

import type {
  LspPrepareRenameRequest,
  LspPrepareRenameResult,
  LspRange,
  LspRenameRequest,
  LspRenameResult,
  LspWorkspaceEdit,
} from "../../../../../shared/src/contracts/editor/editor-bridge";
import {
  buildTextDocumentPositionParams,
  mapProtocolWorkspaceEdit,
} from "./edit-mapping";
import { isProtocolRange, isRecord, mapProtocolRange } from "./read-mapping";

export interface PrepareRenameAdapterContext {
  request: LspPrepareRenameRequest;
  path: string;
  uri: string;
  sendRequest(params: PrepareRenameParams): Promise<unknown>;
}

export interface RenameAdapterContext {
  request: LspRenameRequest;
  path: string;
  uri: string;
  workspaceRoot: string;
  sendRequest(params: RenameParams): Promise<unknown>;
}

export interface LspRenameCapabilityOptions {
  now: () => Date;
}

export class LspRenameCapability {
  public constructor(private readonly options: LspRenameCapabilityOptions) {}

  public async prepareRename(
    context: PrepareRenameAdapterContext,
  ): Promise<LspPrepareRenameResult> {
    const response = await context.sendRequest(
      buildPrepareRenameParams(context.request, context.uri),
    );
    const mapped = mapPrepareRenameResponse(response);

    return {
      type: "lsp-rename/prepare/result",
      workspaceId: context.request.workspaceId,
      path: context.path,
      language: context.request.language,
      canRename: mapped.canRename,
      range: mapped.range,
      placeholder: mapped.placeholder,
      defaultBehavior: mapped.defaultBehavior,
      preparedAt: this.timestamp(),
    };
  }

  public prepareDefaultResult(
    request: LspPrepareRenameRequest,
    path: string,
  ): LspPrepareRenameResult {
    return {
      type: "lsp-rename/prepare/result",
      workspaceId: request.workspaceId,
      path,
      language: request.language,
      canRename: true,
      range: null,
      placeholder: null,
      defaultBehavior: true,
      preparedAt: this.timestamp(),
    };
  }

  public prepareRejectedResult(
    request: LspPrepareRenameRequest,
    path: string,
  ): LspPrepareRenameResult {
    return {
      type: "lsp-rename/prepare/result",
      workspaceId: request.workspaceId,
      path,
      language: request.language,
      canRename: false,
      range: null,
      placeholder: null,
      defaultBehavior: false,
      preparedAt: this.timestamp(),
    };
  }

  public async rename(context: RenameAdapterContext): Promise<LspRenameResult> {
    const response = await context.sendRequest(buildRenameParams(context.request, context.uri));

    return {
      type: "lsp-rename/rename/result",
      workspaceId: context.request.workspaceId,
      path: context.path,
      language: context.request.language,
      workspaceEdit: mapProtocolWorkspaceEdit(response, context.workspaceRoot),
      renamedAt: this.timestamp(),
    };
  }

  public emptyRenameResult(request: LspRenameRequest, path: string): LspRenameResult {
    return {
      type: "lsp-rename/rename/result",
      workspaceId: request.workspaceId,
      path,
      language: request.language,
      workspaceEdit: {
        changes: [],
      },
      renamedAt: this.timestamp(),
    };
  }

  private timestamp(): string {
    return this.options.now().toISOString();
  }
}

export function buildPrepareRenameParams(
  request: LspPrepareRenameRequest,
  uri: string,
): PrepareRenameParams {
  return buildTextDocumentPositionParams(uri, request.position);
}

export function buildRenameParams(request: LspRenameRequest, uri: string): RenameParams {
  return {
    ...buildTextDocumentPositionParams(uri, request.position),
    newName: request.newName,
  };
}

export function mapPrepareRenameResponse(response: unknown): {
  canRename: boolean;
  range: LspRange | null;
  placeholder: string | null;
  defaultBehavior: boolean;
} {
  if (response === null || response === undefined) {
    return {
      canRename: false,
      range: null,
      placeholder: null,
      defaultBehavior: false,
    };
  }

  if (isProtocolRange(response)) {
    return {
      canRename: true,
      range: mapProtocolRange(response),
      placeholder: null,
      defaultBehavior: false,
    };
  }

  if (isRecord(response) && response.defaultBehavior === true) {
    return {
      canRename: true,
      range: null,
      placeholder: null,
      defaultBehavior: true,
    };
  }

  if (isRecord(response) && isProtocolRange(response.range)) {
    return {
      canRename: true,
      range: mapProtocolRange(response.range),
      placeholder: typeof response.placeholder === "string" ? response.placeholder : null,
      defaultBehavior: false,
    };
  }

  return {
    canRename: false,
    range: null,
    placeholder: null,
    defaultBehavior: false,
  };
}

export function workspaceEditIsEmpty(edit: LspWorkspaceEdit): boolean {
  return edit.changes.every((change) => change.edits.length === 0);
}
