import type * as Monaco from "monaco-editor";

interface DiagnosticsOptions {
  noSemanticValidation?: boolean;
  noSyntaxValidation?: boolean;
  noSuggestionDiagnostics?: boolean;
}

interface CompilerOptions {
  noLib?: boolean;
  allowNonTsExtensions?: boolean;
  allowJs?: boolean;
}

interface ModeConfiguration {
  completionItems?: boolean;
  hovers?: boolean;
  documentSymbols?: boolean;
  definitions?: boolean;
  references?: boolean;
  documentHighlights?: boolean;
  rename?: boolean;
  diagnostics?: boolean;
  documentRangeFormattingEdits?: boolean;
  signatureHelp?: boolean;
  onTypeFormattingEdits?: boolean;
  codeActions?: boolean;
  inlayHints?: boolean;
}

interface LanguageDefaults {
  setDiagnosticsOptions(options: DiagnosticsOptions): void;
  setCompilerOptions(options: CompilerOptions): void;
  setExtraLibs(libs: ReadonlyArray<unknown>): void;
  setEagerModelSync(value: boolean): void;
  setModeConfiguration?(config: ModeConfiguration): void;
}

interface TypeScriptApi {
  typescriptDefaults: LanguageDefaults;
  javascriptDefaults: LanguageDefaults;
}

function getTypeScriptApi(monaco: typeof Monaco): TypeScriptApi | null {
  const namespace = (monaco.languages as unknown as { typescript?: unknown }).typescript;
  if (!namespace || typeof namespace !== "object") return null;
  const api = namespace as Partial<TypeScriptApi>;
  if (!api.typescriptDefaults || !api.javascriptDefaults) return null;
  return api as TypeScriptApi;
}

function neutralize(defaults: LanguageDefaults): void {
  defaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
    noSuggestionDiagnostics: true,
  });
  defaults.setCompilerOptions({
    noLib: true,
    allowNonTsExtensions: true,
    allowJs: false,
  });
  defaults.setExtraLibs([]);
  defaults.setEagerModelSync(false);
  defaults.setModeConfiguration?.({
    completionItems: false,
    hovers: false,
    documentSymbols: false,
    definitions: false,
    references: false,
    documentHighlights: false,
    rename: false,
    diagnostics: false,
    documentRangeFormattingEdits: false,
    signatureHelp: false,
    onTypeFormattingEdits: false,
    codeActions: false,
    inlayHints: false,
  });
}

export function neutralizeBuiltInTypeScriptWorker(monaco: typeof Monaco): void {
  const tsApi = getTypeScriptApi(monaco);
  if (!tsApi) return;

  neutralize(tsApi.typescriptDefaults);
  neutralize(tsApi.javascriptDefaults);
}
