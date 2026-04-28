import type {
  LspHoverContent,
  LspHoverRequest,
  LspHoverResult,
  LspLanguage,
} from "../../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import { mapRangeToMonaco } from "./read-provider-mapping";

type MonacoApi = typeof import("monaco-editor");
type MonacoModel = import("monaco-editor").editor.ITextModel;
type MonacoDisposable = import("monaco-editor").IDisposable;
type MonacoHover = import("monaco-editor").languages.Hover;
type MonacoMarkdownString = import("monaco-editor").IMarkdownString;

export interface LspHoverEditorApi {
  invoke(request: LspHoverRequest): Promise<LspHoverResult>;
}

export interface RegisterLspHoverProviderOptions {
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  languageId: string;
  model: MonacoModel;
  editorApi: LspHoverEditorApi;
}

export function registerLspHoverProvider(
  monaco: MonacoApi,
  options: RegisterLspHoverProviderOptions,
): MonacoDisposable {
  return monaco.languages.registerHoverProvider(options.languageId, {
    provideHover: async (model, position) => {
      if (model !== options.model) {
        return null;
      }

      try {
        const result = await options.editorApi.invoke({
          type: "lsp-hover/read",
          workspaceId: options.workspaceId,
          path: options.path,
          language: options.language,
          position: {
            line: position.lineNumber - 1,
            character: position.column - 1,
          },
        });

        return mapLspHoverToMonaco(monaco, result);
      } catch (error) {
        console.error("Monaco hover provider: hover request failed.", error);
        return null;
      }
    },
  });
}

export function mapLspHoverToMonaco(
  monaco: MonacoApi,
  result: LspHoverResult,
): MonacoHover | null {
  if (result.contents.length === 0) {
    return null;
  }

  return {
    contents: result.contents.map(mapLspHoverContentToMonaco),
    range: result.range ? mapRangeToMonaco(monaco, result.range) : undefined,
  };
}

export function mapLspHoverContentToMonaco(
  content: LspHoverContent,
): MonacoMarkdownString {
  return {
    value:
      content.kind === "plaintext"
        ? escapeMarkdownPlaintext(content.value)
        : content.value,
    isTrusted: false,
    supportHtml: false,
  };
}

export function escapeMarkdownPlaintext(value: string): string {
  return value.replace(/[\\`*_[\]{}()#+\-.!|>]/g, "\\$&");
}
