import type {
  LspCodeAction,
  LspCodeActionRequest,
  LspCodeActionResult,
  LspDiagnostic,
  LspLanguage,
  LspWorkspaceEdit,
  LspWorkspaceEditApplicationResult,
} from "../../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";

type MonacoApi = typeof import("monaco-editor");
type MonacoModel = import("monaco-editor").editor.ITextModel;
type MonacoRange = import("monaco-editor").Range;
type MonacoMarkerData = import("monaco-editor").editor.IMarkerData;
type MonacoCodeAction = import("monaco-editor").languages.CodeAction;
type MonacoCodeActionContext = import("monaco-editor").languages.CodeActionContext;
type MonacoDisposable = import("monaco-editor").IDisposable;

export interface LspCodeActionEditorApi {
  invoke(request: LspCodeActionRequest): Promise<LspCodeActionResult>;
}

export interface RegisterLspCodeActionProviderOptions {
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  languageId: string;
  model: MonacoModel;
  editorApi: LspCodeActionEditorApi;
  applyWorkspaceEdit(
    workspaceId: WorkspaceId,
    edit: LspWorkspaceEdit,
  ): Promise<LspWorkspaceEditApplicationResult>;
}

let nextCodeActionCommandId = 1;

export function registerLspCodeActionProvider(
  monaco: MonacoApi,
  options: RegisterLspCodeActionProviderOptions,
): MonacoDisposable {
  const commandId = `nexus.lsp.applyCodeAction.${nextCodeActionCommandId++}`;
  const commandDisposable = monaco.editor.registerCommand(commandId, (_accessor, action: LspCodeAction) => {
    if (!action.edit) {
      return;
    }

    void options.applyWorkspaceEdit(options.workspaceId, action.edit).catch((error) => {
      console.error("Monaco code action provider: failed to apply workspace edit.", error);
    });
  });
  const providerDisposable = monaco.languages.registerCodeActionProvider(
    options.languageId,
    {
      provideCodeActions: async (model, range, context) => {
        if (model !== options.model) {
          return {
            actions: [],
            dispose() {},
          };
        }

        try {
          const result = await options.editorApi.invoke({
            type: "lsp-code-action/list",
            workspaceId: options.workspaceId,
            path: options.path,
            language: options.language,
            range: monacoRangeToLsp(range),
            diagnostics: context.markers.map((marker) =>
              monacoMarkerToLspDiagnostic(monaco, marker, options.path, options.language),
            ),
            only: context.only ?? null,
          });
          return {
            actions: result.actions.map((action) =>
              mapLspCodeActionToMonaco(monaco, action, commandId, context),
            ),
            dispose() {},
          };
        } catch (error) {
          console.error("Monaco code action provider: request failed.", error);
          return {
            actions: [],
            dispose() {},
          };
        }
      },
    },
    {
      providedCodeActionKinds: ["quickfix", "source", "source.fixAll", "source.organizeImports"],
    },
  );

  return {
    dispose() {
      providerDisposable.dispose();
      commandDisposable.dispose();
    },
  };
}

export function mapLspCodeActionToMonaco(
  monaco: MonacoApi,
  action: LspCodeAction,
  commandId: string,
  context?: MonacoCodeActionContext,
): MonacoCodeAction {
  const disabled =
    action.disabledReason ??
    (!action.edit && action.command
      ? "LSP command execution is not supported yet."
      : undefined);

  return {
    title: action.title,
    kind: action.kind ?? undefined,
    diagnostics:
      action.diagnostics.length > 0
        ? action.diagnostics.map((diagnostic) =>
            lspDiagnosticToMonacoMarker(monaco, diagnostic),
          )
        : context?.markers,
    isPreferred: action.isPreferred ?? undefined,
    disabled,
    command: disabled
      ? undefined
      : {
          id: commandId,
          title: action.command?.title ?? action.title,
          arguments: [action],
        },
  };
}

function monacoMarkerToLspDiagnostic(
  monaco: MonacoApi,
  marker: MonacoMarkerData,
  path: string,
  language: LspLanguage,
): LspDiagnostic {
  return {
    path,
    language,
    range: {
      start: {
        line: marker.startLineNumber - 1,
        character: marker.startColumn - 1,
      },
      end: {
        line: marker.endLineNumber - 1,
        character: marker.endColumn - 1,
      },
    },
    severity: lspSeverityFromMonaco(monaco, marker.severity),
    message: marker.message,
    source: marker.source ?? null,
    code: typeof marker.code === "object" ? marker.code.value : marker.code ?? null,
  };
}

function lspDiagnosticToMonacoMarker(
  monaco: MonacoApi,
  diagnostic: LspDiagnostic,
): MonacoMarkerData {
  return {
    startLineNumber: diagnostic.range.start.line + 1,
    startColumn: diagnostic.range.start.character + 1,
    endLineNumber: diagnostic.range.end.line + 1,
    endColumn: diagnostic.range.end.character + 1,
    severity: monacoSeverityFromLsp(monaco, diagnostic.severity),
    message: diagnostic.message,
    source: diagnostic.source ?? undefined,
    code: diagnostic.code ?? undefined,
  };
}

function monacoRangeToLsp(range: MonacoRange): LspCodeActionRequest["range"] {
  return {
    start: {
      line: range.startLineNumber - 1,
      character: range.startColumn - 1,
    },
    end: {
      line: range.endLineNumber - 1,
      character: range.endColumn - 1,
    },
  };
}

function lspSeverityFromMonaco(
  monaco: MonacoApi,
  severity: MonacoMarkerData["severity"],
): LspDiagnostic["severity"] {
  switch (severity) {
    case monaco.MarkerSeverity.Error:
      return "error";
    case monaco.MarkerSeverity.Warning:
      return "warning";
    case monaco.MarkerSeverity.Hint:
      return "hint";
    case monaco.MarkerSeverity.Info:
    default:
      return "information";
  }
}

function monacoSeverityFromLsp(
  monaco: MonacoApi,
  severity: LspDiagnostic["severity"],
): MonacoMarkerData["severity"] {
  switch (severity) {
    case "error":
      return monaco.MarkerSeverity.Error;
    case "warning":
      return monaco.MarkerSeverity.Warning;
    case "hint":
      return monaco.MarkerSeverity.Hint;
    case "information":
      return monaco.MarkerSeverity.Info;
  }
}
