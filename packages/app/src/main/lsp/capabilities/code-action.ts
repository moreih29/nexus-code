import type {
  CodeAction as ProtocolCodeAction,
  CodeActionParams,
  Command as ProtocolCommand,
} from "vscode-languageserver-protocol";

import type {
  LspCodeAction,
  LspCodeActionRequest,
  LspCodeActionResult,
  LspCommand,
} from "../../../../../shared/src/contracts/editor/editor-bridge";
import {
  mapProtocolWorkspaceEdit,
  mapSharedDiagnosticToProtocol,
} from "./edit-mapping";
import { mapDiagnostic } from "./diagnostics";
import { isRecord } from "./read-mapping";

export interface CodeActionAdapterContext {
  request: LspCodeActionRequest;
  path: string;
  uri: string;
  workspaceRoot: string;
  sendRequest(params: CodeActionParams): Promise<unknown>;
}

export interface LspCodeActionCapabilityOptions {
  now: () => Date;
}

export class LspCodeActionCapability {
  public constructor(private readonly options: LspCodeActionCapabilityOptions) {}

  public async codeActions(context: CodeActionAdapterContext): Promise<LspCodeActionResult> {
    const response = await context.sendRequest(
      buildCodeActionParams(context.request, context.uri),
    );

    return {
      type: "lsp-code-action/list/result",
      workspaceId: context.request.workspaceId,
      path: context.path,
      language: context.request.language,
      actions: mapCodeActionResponse(
        response,
        context.workspaceRoot,
        context.path,
        context.request.language,
      ),
      listedAt: this.timestamp(),
    };
  }

  public emptyResult(
    request: LspCodeActionRequest,
    path: string,
  ): LspCodeActionResult {
    return {
      type: "lsp-code-action/list/result",
      workspaceId: request.workspaceId,
      path,
      language: request.language,
      actions: [],
      listedAt: this.timestamp(),
    };
  }

  private timestamp(): string {
    return this.options.now().toISOString();
  }
}

export function buildCodeActionParams(
  request: LspCodeActionRequest,
  uri: string,
): CodeActionParams {
  return {
    textDocument: {
      uri,
    },
    range: request.range,
    context: {
      diagnostics: (request.diagnostics ?? []).map(mapSharedDiagnosticToProtocol),
      only: request.only ? [request.only] : undefined,
    },
  };
}

export function mapCodeActionResponse(
  response: unknown,
  workspaceRoot: string,
  path: string,
  language: LspCodeActionRequest["language"],
): LspCodeAction[] {
  if (!Array.isArray(response)) {
    return [];
  }

  return response.flatMap((item) => {
    if (isProtocolCommand(item)) {
      return [
        {
          title: item.title,
          diagnostics: [],
          command: mapCommand(item),
        },
      ];
    }

    if (isProtocolCodeAction(item)) {
      return [mapCodeAction(item, workspaceRoot, path, language)];
    }

    return [];
  });
}

function mapCodeAction(
  action: ProtocolCodeAction,
  workspaceRoot: string,
  path: string,
  language: LspCodeActionRequest["language"],
): LspCodeAction {
  return {
    title: action.title,
    kind: typeof action.kind === "string" ? action.kind : null,
    diagnostics: (action.diagnostics ?? []).map((diagnostic) =>
      mapDiagnostic(diagnostic, path, language),
    ),
    edit: action.edit ? mapProtocolWorkspaceEdit(action.edit, workspaceRoot) : null,
    command: action.command ? mapCommand(action.command) : null,
    isPreferred: action.isPreferred ?? null,
    disabledReason: isRecord(action.disabled) && typeof action.disabled.reason === "string"
      ? action.disabled.reason
      : null,
  };
}

function mapCommand(command: ProtocolCommand): LspCommand {
  return {
    title: command.title,
    command: command.command,
    arguments: command.arguments ?? null,
  };
}

function isProtocolCodeAction(value: unknown): value is ProtocolCodeAction {
  return (
    isRecord(value) &&
    typeof value.title === "string" &&
    typeof value.command !== "string"
  );
}

function isProtocolCommand(value: unknown): value is ProtocolCommand {
  return (
    isRecord(value) &&
    typeof value.title === "string" &&
    typeof value.command === "string" &&
    !("edit" in value)
  );
}
