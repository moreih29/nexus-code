import type {
  LspCompletionEditRange,
  LspCompletionInsertTextFormat,
  LspCompletionItem,
  LspCompletionItemKind,
  LspCompletionRequest,
  LspCompletionResult,
  LspCompletionTextEdit,
  LspCompletionTriggerKind,
  LspLanguage,
} from "../../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";

type MonacoApi = typeof import("monaco-editor");
type MonacoModel = import("monaco-editor").editor.ITextModel;
type MonacoPosition = import("monaco-editor").Position;
type MonacoRange = import("monaco-editor").IRange;
type MonacoCompletionContext = import("monaco-editor").languages.CompletionContext;
type MonacoCompletionItem = import("monaco-editor").languages.CompletionItem;
type MonacoCompletionItemKindMap =
  typeof import("monaco-editor").languages.CompletionItemKind;
type MonacoDisposable = import("monaco-editor").IDisposable;

export interface LspCompletionEditorApi {
  invoke(request: LspCompletionRequest): Promise<LspCompletionResult>;
}

export interface RegisterLspCompletionProviderOptions {
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  languageId: string;
  model: MonacoModel;
  editorApi: LspCompletionEditorApi;
}

export function registerLspCompletionProvider(
  monaco: MonacoApi,
  options: RegisterLspCompletionProviderOptions,
): MonacoDisposable {
  return monaco.languages.registerCompletionItemProvider(options.languageId, {
    triggerCharacters: completionTriggerCharactersFor(options.language),
    provideCompletionItems: async (model, position, context) => {
      if (model !== options.model) {
        return {
          suggestions: [],
        };
      }

      try {
        const result = await options.editorApi.invoke({
          type: "lsp-completion/complete",
          workspaceId: options.workspaceId,
          path: options.path,
          language: options.language,
          position: {
            line: position.lineNumber - 1,
            character: position.column - 1,
          },
          triggerKind: mapMonacoTriggerKind(monaco, context),
          triggerCharacter: context.triggerCharacter ?? null,
        });
        const defaultRange = defaultCompletionRange(monaco, model, position);

        return {
          incomplete: result.isIncomplete,
          suggestions: result.items.map((item) =>
            mapLspCompletionItemToMonaco(monaco, item, defaultRange),
          ),
        };
      } catch (error) {
        console.error("Monaco completion provider: completion request failed.", error);
        return {
          suggestions: [],
        };
      }
    },
  });
}

export function mapLspCompletionItemToMonaco(
  monaco: MonacoApi,
  item: LspCompletionItem,
  defaultRange: MonacoRange,
): MonacoCompletionItem {
  return {
    label: item.label,
    kind: mapCompletionItemKindToMonaco(item.kind, monaco.languages.CompletionItemKind),
    detail: item.detail ?? undefined,
    documentation: item.documentation ? { value: item.documentation } : undefined,
    sortText: item.sortText ?? undefined,
    filterText: item.filterText ?? undefined,
    insertText: item.insertText,
    insertTextRules: mapInsertTextRules(monaco, item.insertTextFormat),
    range: item.range ? mapCompletionEditRangeToMonaco(monaco, item.range) : defaultRange,
    additionalTextEdits: item.additionalTextEdits.map((edit) =>
      mapTextEditToMonaco(monaco, edit),
    ),
    commitCharacters: item.commitCharacters ?? undefined,
    preselect: item.preselect ?? undefined,
    tags: item.deprecated ? [monaco.languages.CompletionItemTag.Deprecated] : undefined,
  };
}

export function mapCompletionItemKindToMonaco(
  kind: LspCompletionItemKind,
  completionItemKind: MonacoCompletionItemKindMap,
): number {
  switch (kind) {
    case "method":
      return completionItemKind.Method;
    case "function":
      return completionItemKind.Function;
    case "constructor":
      return completionItemKind.Constructor;
    case "field":
      return completionItemKind.Field;
    case "variable":
      return completionItemKind.Variable;
    case "class":
      return completionItemKind.Class;
    case "interface":
      return completionItemKind.Interface;
    case "module":
      return completionItemKind.Module;
    case "property":
      return completionItemKind.Property;
    case "unit":
      return completionItemKind.Unit;
    case "value":
      return completionItemKind.Value;
    case "enum":
      return completionItemKind.Enum;
    case "keyword":
      return completionItemKind.Keyword;
    case "snippet":
      return completionItemKind.Snippet;
    case "color":
      return completionItemKind.Color;
    case "file":
      return completionItemKind.File;
    case "reference":
      return completionItemKind.Reference;
    case "folder":
      return completionItemKind.Folder;
    case "enum-member":
      return completionItemKind.EnumMember;
    case "constant":
      return completionItemKind.Constant;
    case "struct":
      return completionItemKind.Struct;
    case "event":
      return completionItemKind.Event;
    case "operator":
      return completionItemKind.Operator;
    case "type-parameter":
      return completionItemKind.TypeParameter;
    case "text":
    default:
      return completionItemKind.Text;
  }
}

function mapMonacoTriggerKind(
  monaco: MonacoApi,
  context: MonacoCompletionContext,
): LspCompletionTriggerKind {
  switch (context.triggerKind) {
    case monaco.languages.CompletionTriggerKind.TriggerCharacter:
      return "trigger-character";
    case monaco.languages.CompletionTriggerKind.TriggerForIncompleteCompletions:
      return "trigger-for-incomplete-completions";
    case monaco.languages.CompletionTriggerKind.Invoke:
    default:
      return "invoked";
  }
}

function mapInsertTextRules(
  monaco: MonacoApi,
  insertTextFormat: LspCompletionInsertTextFormat,
): number | undefined {
  return insertTextFormat === "snippet"
    ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
    : undefined;
}

function mapCompletionEditRangeToMonaco(
  monaco: MonacoApi,
  range: LspCompletionEditRange,
): MonacoCompletionItem["range"] {
  if ("insert" in range && "replace" in range) {
    return {
      insert: mapRangeToMonaco(monaco, range.insert),
      replace: mapRangeToMonaco(monaco, range.replace),
    };
  }

  return mapRangeToMonaco(monaco, range);
}

function mapTextEditToMonaco(
  monaco: MonacoApi,
  edit: LspCompletionTextEdit,
): import("monaco-editor").editor.ISingleEditOperation {
  return {
    range: mapRangeToMonaco(monaco, edit.range),
    text: edit.newText,
  };
}

function mapRangeToMonaco(
  monaco: MonacoApi,
  range: LspCompletionTextEdit["range"],
): import("monaco-editor").Range {
  return new monaco.Range(
    range.start.line + 1,
    range.start.character + 1,
    range.end.line + 1,
    range.end.character + 1,
  );
}

function defaultCompletionRange(
  monaco: MonacoApi,
  model: MonacoModel,
  position: MonacoPosition,
): MonacoRange {
  const word = model.getWordUntilPosition(position);
  return new monaco.Range(
    position.lineNumber,
    word.startColumn,
    position.lineNumber,
    word.endColumn,
  );
}

function completionTriggerCharactersFor(language: LspLanguage): string[] {
  switch (language) {
    case "typescript":
      return [".", "'", "\"", "`", "/", "@"];
    case "python":
      return [".", "'", "\""];
    case "go":
      return [".", "\""];
  }
}
