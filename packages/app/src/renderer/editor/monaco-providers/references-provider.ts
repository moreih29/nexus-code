import type {
  LspLanguage,
  LspReferencesRequest,
  LspReferencesResult,
} from "../../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import { mapLspLocationToMonaco } from "./read-provider-mapping";

type MonacoApi = typeof import("monaco-editor");
type MonacoModel = import("monaco-editor").editor.ITextModel;
type MonacoDisposable = import("monaco-editor").IDisposable;
type MonacoLocation = import("monaco-editor").languages.Location;

export interface LspReferencesEditorApi {
  invoke(request: LspReferencesRequest): Promise<LspReferencesResult>;
}

export interface RegisterLspReferencesProviderOptions {
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  languageId: string;
  model: MonacoModel;
  editorApi: LspReferencesEditorApi;
}

export function registerLspReferencesProvider(
  monaco: MonacoApi,
  options: RegisterLspReferencesProviderOptions,
): MonacoDisposable {
  return monaco.languages.registerReferenceProvider(options.languageId, {
    provideReferences: async (model, position, context) => {
      if (model !== options.model) {
        return [];
      }

      try {
        const result = await options.editorApi.invoke({
          type: "lsp-references/read",
          workspaceId: options.workspaceId,
          path: options.path,
          language: options.language,
          position: {
            line: position.lineNumber - 1,
            character: position.column - 1,
          },
          includeDeclaration: context.includeDeclaration,
        });

        return mapLspReferencesToMonaco(monaco, options.workspaceId, result);
      } catch (error) {
        console.error("Monaco references provider: references request failed.", error);
        return [];
      }
    },
  });
}

export function mapLspReferencesToMonaco(
  monaco: MonacoApi,
  workspaceId: WorkspaceId,
  result: LspReferencesResult,
): MonacoLocation[] {
  return result.locations.map((location) =>
    mapLspLocationToMonaco(monaco, workspaceId, location),
  );
}
