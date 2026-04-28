import type {
  LspLanguage,
  LspPrepareRenameRequest,
  LspPrepareRenameResult,
  LspRenameRequest,
  LspRenameResult,
  LspWorkspaceEdit,
  LspWorkspaceEditApplicationResult,
} from "../../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";

type MonacoApi = typeof import("monaco-editor");
type MonacoModel = import("monaco-editor").editor.ITextModel;
type MonacoPosition = import("monaco-editor").Position;
type MonacoRange = import("monaco-editor").Range;
type MonacoDisposable = import("monaco-editor").IDisposable;

export interface LspRenameEditorApi {
  invoke(
    request: LspPrepareRenameRequest,
  ): Promise<LspPrepareRenameResult>;
  invoke(request: LspRenameRequest): Promise<LspRenameResult>;
}

export interface RegisterLspRenameProviderOptions {
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  languageId: string;
  model: MonacoModel;
  editorApi: LspRenameEditorApi;
  applyWorkspaceEdit(
    workspaceId: WorkspaceId,
    edit: LspWorkspaceEdit,
  ): Promise<LspWorkspaceEditApplicationResult>;
}

export function registerLspRenameProvider(
  monaco: MonacoApi,
  options: RegisterLspRenameProviderOptions,
): MonacoDisposable {
  return monaco.languages.registerRenameProvider(options.languageId, {
    resolveRenameLocation: async (model, position) => {
      if (model !== options.model) {
        return {
          rejectReason: "Rename is only available for the active model.",
        };
      }

      try {
        const result = await options.editorApi.invoke({
          type: "lsp-rename/prepare",
          workspaceId: options.workspaceId,
          path: options.path,
          language: options.language,
          position: monacoPositionToLsp(position),
        });
        if (!result.canRename) {
          return {
            rejectReason: "The symbol at this location cannot be renamed.",
          };
        }

        if (result.range) {
          return {
            range: lspRangeToMonaco(monaco, result.range),
            text: result.placeholder ?? model.getValueInRange(lspRangeToMonaco(monaco, result.range)),
          };
        }

        return defaultRenameLocation(monaco, model, position);
      } catch (error) {
        console.error("Monaco rename provider: prepareRename request failed.", error);
        return {
          rejectReason: "Unable to prepare rename.",
        };
      }
    },
    provideRenameEdits: async (model, position, newName) => {
      if (model !== options.model) {
        return {
          edits: [],
          rejectReason: "Rename is only available for the active model.",
        };
      }

      try {
        const result = await options.editorApi.invoke({
          type: "lsp-rename/rename",
          workspaceId: options.workspaceId,
          path: options.path,
          language: options.language,
          position: monacoPositionToLsp(position),
          newName,
        });
        const application = await options.applyWorkspaceEdit(
          options.workspaceId,
          result.workspaceEdit,
        );

        if (!application.applied) {
          return {
            edits: [],
            rejectReason: "Rename produced no edits for open files.",
          };
        }

        return {
          edits: [],
        };
      } catch (error) {
        console.error("Monaco rename provider: rename request failed.", error);
        return {
          edits: [],
          rejectReason: "Unable to rename symbol.",
        };
      }
    },
  });
}

function defaultRenameLocation(
  monaco: MonacoApi,
  model: MonacoModel,
  position: MonacoPosition,
): {
  range: MonacoRange;
  text: string;
} {
  const word = model.getWordAtPosition(position) ?? model.getWordUntilPosition(position);
  return {
    range: new monaco.Range(
      position.lineNumber,
      word.startColumn,
      position.lineNumber,
      word.endColumn,
    ),
    text: word.word,
  };
}

function monacoPositionToLsp(position: MonacoPosition): { line: number; character: number } {
  return {
    line: position.lineNumber - 1,
    character: position.column - 1,
  };
}

function lspRangeToMonaco(
  monaco: MonacoApi,
  range: LspPrepareRenameResult["range"],
): MonacoRange {
  if (!range) {
    throw new Error("Cannot map empty LSP range.");
  }

  return new monaco.Range(
    range.start.line + 1,
    range.start.character + 1,
    range.end.line + 1,
    range.end.character + 1,
  );
}
