import type {
  LspDefinitionRequest,
  LspDefinitionResult,
  LspLanguage,
} from "../../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import { mapLspDefinitionTargetToMonaco } from "./read-provider-mapping";

type MonacoApi = typeof import("monaco-editor");
type MonacoModel = import("monaco-editor").editor.ITextModel;
type MonacoDisposable = import("monaco-editor").IDisposable;
type MonacoDefinition = import("monaco-editor").languages.Definition;

export interface LspDefinitionEditorApi {
  invoke(request: LspDefinitionRequest): Promise<LspDefinitionResult>;
}

export interface RegisterLspDefinitionProviderOptions {
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  languageId: string;
  model: MonacoModel;
  editorApi: LspDefinitionEditorApi;
}

export function registerLspDefinitionProvider(
  monaco: MonacoApi,
  options: RegisterLspDefinitionProviderOptions,
): MonacoDisposable {
  return monaco.languages.registerDefinitionProvider(options.languageId, {
    provideDefinition: async (model, position) => {
      if (model !== options.model) {
        return [];
      }

      try {
        const result = await options.editorApi.invoke({
          type: "lsp-definition/read",
          workspaceId: options.workspaceId,
          path: options.path,
          language: options.language,
          position: {
            line: position.lineNumber - 1,
            character: position.column - 1,
          },
        });

        return mapLspDefinitionToMonaco(monaco, options.workspaceId, result);
      } catch (error) {
        console.error("Monaco definition provider: definition request failed.", error);
        return [];
      }
    },
  });
}

export function mapLspDefinitionToMonaco(
  monaco: MonacoApi,
  workspaceId: WorkspaceId,
  result: LspDefinitionResult,
): MonacoDefinition {
  return result.targets.map((target) =>
    mapLspDefinitionTargetToMonaco(monaco, workspaceId, target),
  );
}
