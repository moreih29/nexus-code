import type {
  LspDocumentFormattingRequest,
  LspDocumentFormattingResult,
  LspLanguage,
  LspRangeFormattingRequest,
  LspRangeFormattingResult,
  LspTextEdit,
} from "../../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";

type MonacoApi = typeof import("monaco-editor");
type MonacoModel = import("monaco-editor").editor.ITextModel;
type MonacoRange = import("monaco-editor").Range;
type MonacoFormattingOptions = import("monaco-editor").languages.FormattingOptions;
type MonacoTextEdit = import("monaco-editor").languages.TextEdit;
type MonacoDisposable = import("monaco-editor").IDisposable;

export interface LspFormattingEditorApi {
  invoke(
    request: LspDocumentFormattingRequest,
  ): Promise<LspDocumentFormattingResult>;
  invoke(request: LspRangeFormattingRequest): Promise<LspRangeFormattingResult>;
}

export interface RegisterLspFormattingProviderOptions {
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  languageId: string;
  model: MonacoModel;
  editorApi: LspFormattingEditorApi;
}

export function registerLspFormattingProviders(
  monaco: MonacoApi,
  options: RegisterLspFormattingProviderOptions,
): MonacoDisposable {
  const documentFormattingDisposable =
    monaco.languages.registerDocumentFormattingEditProvider(options.languageId, {
      displayName: "Nexus LSP",
      provideDocumentFormattingEdits: async (model, formattingOptions) => {
        if (model !== options.model) {
          return [];
        }

        try {
          const result = await options.editorApi.invoke({
            type: "lsp-formatting/document",
            workspaceId: options.workspaceId,
            path: options.path,
            language: options.language,
            options: mapFormattingOptions(formattingOptions),
          });
          return result.edits.map((edit) => lspTextEditToMonaco(monaco, edit));
        } catch (error) {
          console.error("Monaco formatting provider: document format failed.", error);
          return [];
        }
      },
    });
  const rangeFormattingDisposable =
    monaco.languages.registerDocumentRangeFormattingEditProvider(options.languageId, {
      displayName: "Nexus LSP",
      provideDocumentRangeFormattingEdits: async (model, range, formattingOptions) => {
        if (model !== options.model) {
          return [];
        }

        try {
          const result = await options.editorApi.invoke({
            type: "lsp-formatting/range",
            workspaceId: options.workspaceId,
            path: options.path,
            language: options.language,
            range: monacoRangeToLsp(range),
            options: mapFormattingOptions(formattingOptions),
          });
          return result.edits.map((edit) => lspTextEditToMonaco(monaco, edit));
        } catch (error) {
          console.error("Monaco formatting provider: range format failed.", error);
          return [];
        }
      },
    });

  return {
    dispose() {
      documentFormattingDisposable.dispose();
      rangeFormattingDisposable.dispose();
    },
  };
}

export function lspTextEditToMonaco(
  monaco: MonacoApi,
  edit: LspTextEdit,
): MonacoTextEdit {
  return {
    range: lspRangeToMonaco(monaco, edit.range),
    text: edit.newText,
  };
}

function mapFormattingOptions(options: MonacoFormattingOptions): {
  tabSize: number;
  insertSpaces: boolean;
} {
  return {
    tabSize: options.tabSize,
    insertSpaces: options.insertSpaces,
  };
}

function monacoRangeToLsp(range: MonacoRange): LspRangeFormattingRequest["range"] {
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

function lspRangeToMonaco(
  monaco: MonacoApi,
  range: LspRangeFormattingRequest["range"],
): MonacoRange {
  return new monaco.Range(
    range.start.line + 1,
    range.start.character + 1,
    range.end.line + 1,
    range.end.character + 1,
  );
}
