import { fileURLToPath } from "node:url";

import type {
  EditorBridgeEvent,
  LspDiagnostic,
  LspDiagnosticSeverity,
  LspDiagnosticsEvent,
  LspDiagnosticsReadRequest,
  LspDiagnosticsReadResult,
  LspLanguage,
} from "../../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import {
  toWorkspaceRelativePath,
  type ResolvedWorkspaceFilePath,
} from "../../workspace/files/workspace-files-paths";
import { normalizeRequestedLanguages } from "../lsp-languages";

export interface ProtocolDiagnostic {
  range?: {
    start?: {
      line?: number;
      character?: number;
    };
    end?: {
      line?: number;
      character?: number;
    };
  };
  severity?: number;
  message?: string;
  source?: string | null;
  code?: string | number | null;
}

export interface PublishDiagnosticsParams {
  uri?: string;
  diagnostics?: ProtocolDiagnostic[];
  version?: number | string | null;
}

export interface LspDiagnosticsPublication {
  workspaceId: WorkspaceId;
  workspaceRoot: string;
  language: LspLanguage;
  params?: PublishDiagnosticsParams;
}

export interface LspDiagnosticsCapabilityOptions {
  now: () => Date;
  emitEvent(event: EditorBridgeEvent): void;
  resolveRequestPath(
    workspaceId: WorkspaceId,
    requestPath: string,
    fieldName: string,
  ): Promise<ResolvedWorkspaceFilePath>;
}

export class LspDiagnosticsCapability {
  private readonly diagnostics = new Map<string, LspDiagnostic[]>();

  public constructor(private readonly options: LspDiagnosticsCapabilityOptions) {}

  public async readDiagnostics(
    request: LspDiagnosticsReadRequest,
  ): Promise<LspDiagnosticsReadResult> {
    const pathFilter = request.path
      ? await this.options.resolveRequestPath(request.workspaceId, request.path, "path")
      : null;
    const languages = normalizeRequestedLanguages(
      request.language ? [request.language] : null,
    );

    const diagnostics: LspDiagnostic[] = [];
    for (const language of languages) {
      if (pathFilter) {
        diagnostics.push(
          ...(
            this.diagnostics.get(
              diagnosticsKey(request.workspaceId, language, pathFilter.relativePath),
            ) ?? []
          ),
        );
        continue;
      }

      const prefix = `${request.workspaceId}:${language}:`;
      for (const [key, pathDiagnostics] of this.diagnostics.entries()) {
        if (key.startsWith(prefix)) {
          diagnostics.push(...pathDiagnostics);
        }
      }
    }

    return {
      type: "lsp-diagnostics/read/result",
      workspaceId: request.workspaceId,
      diagnostics,
      readAt: this.timestamp(),
    };
  }

  public handlePublishDiagnostics(publication: LspDiagnosticsPublication): void {
    const params = publication.params;
    if (!params?.uri) {
      return;
    }

    const pathMapping = mapUriToWorkspacePath(publication.workspaceRoot, params.uri);
    if (!pathMapping) {
      return;
    }

    const diagnostics = (params.diagnostics ?? []).map((diagnostic) =>
      mapDiagnostic(diagnostic, pathMapping.relativePath, publication.language),
    );
    this.diagnostics.set(
      diagnosticsKey(publication.workspaceId, publication.language, pathMapping.relativePath),
      diagnostics,
    );

    const event: LspDiagnosticsEvent = {
      type: "lsp-diagnostics/changed",
      workspaceId: publication.workspaceId,
      path: pathMapping.relativePath,
      language: publication.language,
      diagnostics,
      version: params.version === null || params.version === undefined
        ? null
        : String(params.version),
      publishedAt: this.timestamp(),
    };
    this.options.emitEvent(event);
  }

  public clearDiagnostics(
    workspaceId: WorkspaceId,
    language: LspLanguage,
    relativePath: string,
  ): void {
    this.diagnostics.delete(diagnosticsKey(workspaceId, language, relativePath));
    this.options.emitEvent({
      type: "lsp-diagnostics/changed",
      workspaceId,
      path: relativePath,
      language,
      diagnostics: [],
      version: null,
      publishedAt: this.timestamp(),
    });
  }

  public clearWorkspace(workspaceId: WorkspaceId): void {
    for (const key of Array.from(this.diagnostics.keys())) {
      if (key.startsWith(`${workspaceId}:`)) {
        this.diagnostics.delete(key);
      }
    }
  }

  public dispose(): void {
    this.diagnostics.clear();
  }

  private timestamp(): string {
    return this.options.now().toISOString();
  }
}

export function mapDiagnostic(
  diagnostic: ProtocolDiagnostic,
  relativePath: string,
  language: LspLanguage,
): LspDiagnostic {
  return {
    path: relativePath,
    language,
    range: {
      start: {
        line: diagnostic.range?.start?.line ?? 0,
        character: diagnostic.range?.start?.character ?? 0,
      },
      end: {
        line: diagnostic.range?.end?.line ?? diagnostic.range?.start?.line ?? 0,
        character:
          diagnostic.range?.end?.character ?? diagnostic.range?.start?.character ?? 0,
      },
    },
    severity: severityFromLsp(diagnostic.severity),
    message: diagnostic.message ?? "",
    source: diagnostic.source ?? null,
    code: diagnostic.code ?? null,
  };
}

export function severityFromLsp(severity: number | undefined): LspDiagnosticSeverity {
  switch (severity) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "information";
    case 4:
      return "hint";
    default:
      return "information";
  }
}

function mapUriToWorkspacePath(
  workspaceRoot: string,
  uri: string,
): { absolutePath: string; relativePath: string } | null {
  if (!uri.startsWith("file:")) {
    return null;
  }

  try {
    const absolutePath = fileURLToPath(uri);
    return {
      absolutePath,
      relativePath: toWorkspaceRelativePath(workspaceRoot, absolutePath),
    };
  } catch {
    return null;
  }
}

function diagnosticsKey(
  workspaceId: WorkspaceId,
  language: LspLanguage,
  relativePath: string,
): string {
  return `${workspaceId}:${language}:${relativePath}`;
}
