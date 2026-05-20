// Neutralize Monaco's built-in TypeScript / JavaScript language services.
//
// monaco-editor ships its own TS language worker that runs in a dedicated
// web worker and registers a full provider suite (diagnostics, hover,
// completion, definition, signatureHelp, references, …) for the languageIds
// "typescript", "typescriptreact", "javascript", and "javascriptreact".
// The worker uses hard-coded defaults — moduleResolution: "node", no
// tsconfig discovery, no project context, JSX mode unset — which produce
// phantom diagnostics such as
//   "Cannot find module 'react'. Did you mean to set the 'moduleResolution'
//    option to 'nodenext', or to add aliases to the 'paths' option?"
// and (worse) sometimes hang on .tsx parsing because the worker's parser
// can't make sense of JSX without an explicit jsx compiler option.
//
// Our LSP bridge routes all four flavours through typescript-language-server
// which loads the real tsconfig from the workspace. We need Monaco's
// built-in stack out of the way entirely — Monaco's hover/completion are
// invoked in parallel with ours and the widget aggregates results, so a
// pending built-in provider shows up as a stuck "Loading…" placeholder
// next to our LSP's quickinfo. Silencing diagnostics alone is not enough;
// the other features keep responding (or, in .tsx's case, keep hanging).
//
// Approach: gut the worker's type universe.
//   - setDiagnosticsOptions silences markers.
//   - setCompilerOptions({ noLib: true, … }) strips lib.d.ts and turns the
//     worker into a context-less parser. With no library types, hover and
//     completion have nothing to return — providers resolve to null/empty
//     fast and Monaco merges only our LSP results.
//   - setExtraLibs([]) removes any inherited ambient declarations.
//   - setEagerModelSync(false) stops Monaco from feeding every TS/JS model
//     into the (now-inert) worker; saves memory and avoids loading races.
//
// We deliberately do NOT unregister the language contributions themselves —
// Monaco still uses them for tokenisation (syntax highlighting), brace
// matching, and indentation rules. Those run inside the editor process,
// not the worker, and they remain unaffected by these calls.
//
// Type note: monaco-editor 0.50+ marked `languages.typescript` as a
// deprecated stub (`{ deprecated: true }`) in its public d.ts to push
// consumers toward the standalone @typescript/* packages. The runtime
// API is still there in the default monaco bundle that @monaco-editor/react
// loads — we access it via a typed runtime accessor.

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

interface LanguageDefaults {
  setDiagnosticsOptions(options: DiagnosticsOptions): void;
  setCompilerOptions(options: CompilerOptions): void;
  setExtraLibs(libs: ReadonlyArray<unknown>): void;
  setEagerModelSync(value: boolean): void;
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
  // Strip the worker's type universe. With noLib + empty extraLibs the
  // worker still parses but has no symbols to look up, so providers
  // (hover, completion, definition, signatureHelp, …) resolve immediately
  // with nothing to return and Monaco's hover widget no longer shows a
  // stale "Loading…" while waiting on a built-in response that will never
  // be useful.
  defaults.setCompilerOptions({
    noLib: true,
    allowNonTsExtensions: true,
    allowJs: false,
  });
  defaults.setExtraLibs([]);
  defaults.setEagerModelSync(false);
}

export function neutralizeBuiltInTypeScriptWorker(monaco: typeof Monaco): void {
  const tsApi = getTypeScriptApi(monaco);
  // If the TS language contribution isn't present in this monaco bundle,
  // there's nothing to silence — leave Monaco alone.
  if (!tsApi) return;

  neutralize(tsApi.typescriptDefaults);
  neutralize(tsApi.javascriptDefaults);
}
