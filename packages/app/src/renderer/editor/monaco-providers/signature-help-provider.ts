import type {
  LspLanguage,
  LspSignatureHelp,
  LspSignatureHelpRequest,
  LspSignatureHelpResult,
  LspSignatureHelpTriggerKind,
} from "../../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";

type MonacoApi = typeof import("monaco-editor");
type MonacoModel = import("monaco-editor").editor.ITextModel;
type MonacoPosition = import("monaco-editor").Position;
type MonacoSignatureHelp = import("monaco-editor").languages.SignatureHelp;
type MonacoSignatureHelpContext = import("monaco-editor").languages.SignatureHelpContext;
type MonacoDisposable = import("monaco-editor").IDisposable;

export interface LspSignatureHelpEditorApi {
  invoke(request: LspSignatureHelpRequest): Promise<LspSignatureHelpResult>;
}

export interface RegisterLspSignatureHelpProviderOptions {
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  languageId: string;
  model: MonacoModel;
  editorApi: LspSignatureHelpEditorApi;
}

export function registerLspSignatureHelpProvider(
  monaco: MonacoApi,
  options: RegisterLspSignatureHelpProviderOptions,
): MonacoDisposable {
  return monaco.languages.registerSignatureHelpProvider(options.languageId, {
    signatureHelpTriggerCharacters: signatureHelpTriggerCharactersFor(options.language),
    signatureHelpRetriggerCharacters: signatureHelpRetriggerCharactersFor(options.language),
    provideSignatureHelp: async (model, position, _token, context) => {
      if (model !== options.model) {
        return null;
      }

      try {
        const result = await options.editorApi.invoke({
          type: "lsp-signature-help/get",
          workspaceId: options.workspaceId,
          path: options.path,
          language: options.language,
          position: monacoPositionToLsp(position),
          triggerKind: mapSignatureHelpTriggerKind(monaco, context),
          triggerCharacter: context.triggerCharacter ?? null,
          isRetrigger: context.isRetrigger,
          activeSignatureHelp: context.activeSignatureHelp
            ? mapMonacoSignatureHelpToLsp(context.activeSignatureHelp)
            : null,
        });
        if (!result.signatureHelp || result.signatureHelp.signatures.length === 0) {
          return null;
        }

        return {
          value: mapLspSignatureHelpToMonaco(result.signatureHelp),
          dispose() {},
        };
      } catch (error) {
        console.error("Monaco signature help provider: request failed.", error);
        return null;
      }
    },
  });
}

export function mapLspSignatureHelpToMonaco(
  signatureHelp: LspSignatureHelp,
): MonacoSignatureHelp {
  return {
    signatures: signatureHelp.signatures.map((signature) => ({
      label: signature.label,
      documentation: signature.documentation ? { value: signature.documentation } : undefined,
      parameters: signature.parameters.map((parameter) => ({
        label: parameter.label,
        documentation: parameter.documentation ? { value: parameter.documentation } : undefined,
      })),
      activeParameter: signature.activeParameter ?? undefined,
    })),
    activeSignature: signatureHelp.activeSignature,
    activeParameter: signatureHelp.activeParameter,
  };
}

function mapMonacoSignatureHelpToLsp(
  signatureHelp: MonacoSignatureHelp,
): LspSignatureHelp {
  return {
    signatures: signatureHelp.signatures.map((signature) => ({
      label: signature.label,
      documentation: typeof signature.documentation === "string"
        ? signature.documentation
        : signature.documentation?.value ?? null,
      parameters: signature.parameters.map((parameter) => ({
        label: parameter.label,
        documentation: typeof parameter.documentation === "string"
          ? parameter.documentation
          : parameter.documentation?.value ?? null,
      })),
      activeParameter: signature.activeParameter ?? null,
    })),
    activeSignature: signatureHelp.activeSignature,
    activeParameter: signatureHelp.activeParameter,
  };
}

function mapSignatureHelpTriggerKind(
  monaco: MonacoApi,
  context: MonacoSignatureHelpContext,
): LspSignatureHelpTriggerKind {
  switch (context.triggerKind) {
    case monaco.languages.SignatureHelpTriggerKind.TriggerCharacter:
      return "trigger-character";
    case monaco.languages.SignatureHelpTriggerKind.ContentChange:
      return "content-change";
    case monaco.languages.SignatureHelpTriggerKind.Invoke:
    default:
      return "invoked";
  }
}

function monacoPositionToLsp(position: MonacoPosition): { line: number; character: number } {
  return {
    line: position.lineNumber - 1,
    character: position.column - 1,
  };
}

export function signatureHelpTriggerCharactersFor(language: LspLanguage): string[] {
  switch (language) {
    case "typescript":
    case "python":
    case "go":
      return ["(", ","];
  }
}

function signatureHelpRetriggerCharactersFor(language: LspLanguage): string[] {
  switch (language) {
    case "typescript":
    case "python":
    case "go":
      return [")", ","];
  }
}
