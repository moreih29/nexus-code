// Extra language registration for Monaco editor.
//
// All 80 Monaco basic-languages are already bundled; this module fills in common files
// that have no mapping there.
//
// Strategy: connect a TextMate grammar (JSON) + vscode-textmate + vscode-oniguruma stack
// to monaco.languages.setTokensProvider through an inline bridge.
//
//   - 5 VSCode-compatible grammars (TOML / Makefile / .env / Nix / Justfile) are
//     excerpted from tm-grammars (shikijs).
//   - go.mod / go.sum are not in tm-grammars either, so they use a hand-written Monarch.
//     The DSL is simple (module / require / replace / exclude / retract / go / toolchain
//     + semver), so ~30 lines are enough.
//
// The monaco-editor-textmate package is classified inactive by Snyk, so it is not a
// direct dependency; the ~30-line bridge is inlined here. The tokensProvider cuts the
// first segment off each TextMate scope and maps it to Monaco's default token classes
// (string/comment/keyword/number/variable/...). Full-scope theme matching is
// unrelated to our Monaco theme system, so it is omitted on purpose.

import type * as Monaco from "monaco-editor";
import dotenvGrammar from "tm-grammars/grammars/dotenv.json";
import justGrammar from "tm-grammars/grammars/just.json";
import makeGrammar from "tm-grammars/grammars/make.json";
import nixGrammar from "tm-grammars/grammars/nix.json";
import tomlGrammar from "tm-grammars/grammars/toml.json";
import { loadWASM, OnigScanner, OnigString } from "vscode-oniguruma";
// Vite asset URL — emits onig.wasm as a static asset the renderer fetches at boot.
import onigWasmUrl from "vscode-oniguruma/release/onig.wasm?url";
import type { IRawGrammar, StateStack } from "vscode-textmate";
import { INITIAL, Registry } from "vscode-textmate";
import { createLogger } from "../../../../shared/log/renderer";

// ---------------------------------------------------------------------------
// TextMate language registry
// ---------------------------------------------------------------------------

interface TmLangSpec {
  /** Monaco language id. */
  id: string;
  /** Top-level scope from the tmGrammar JSON. */
  scopeName: string;
  grammar: IRawGrammar;
  /** File patterns. */
  extensions?: string[];
  filenames?: string[];
}

const log = createLogger("extra-languages");

const TM_LANGUAGES: readonly TmLangSpec[] = [
  {
    id: "toml",
    scopeName: "source.toml",
    grammar: tomlGrammar as unknown as IRawGrammar,
    extensions: [".toml"],
  },
  {
    id: "makefile",
    scopeName: "source.makefile",
    grammar: makeGrammar as unknown as IRawGrammar,
    extensions: [".mk", ".mak", ".make"],
    filenames: ["Makefile", "makefile", "GNUmakefile", "BSDmakefile"],
  },
  {
    // Monaco "ini" is not mapped to .env, so it is registered under a separate id.
    // Highlighting is close to ini, but the dotenv grammar also picks up dotenv-specific
    // tokens such as the export prefix and quote escapes.
    id: "dotenv",
    scopeName: "source.dotenv",
    grammar: dotenvGrammar as unknown as IRawGrammar,
    extensions: [".env"],
    filenames: [
      ".env",
      ".env.local",
      ".env.development",
      ".env.production",
      ".env.test",
      ".env.example",
      ".env.development.local",
      ".env.production.local",
      ".env.test.local",
    ],
  },
  {
    id: "nix",
    scopeName: "source.nix",
    grammar: nixGrammar as unknown as IRawGrammar,
    extensions: [".nix"],
  },
  {
    id: "just",
    scopeName: "source.just",
    grammar: justGrammar as unknown as IRawGrammar,
    extensions: [".just"],
    filenames: ["justfile", "Justfile", ".justfile"],
  },
];

// ---------------------------------------------------------------------------
// Scope → Monaco token name mapping
// ---------------------------------------------------------------------------

/**
 * TextMate scopes are dot-separated hierarchical strings like "string.quoted.double.toml".
 * Monaco's default theme rules recognize the first segment (`string`, `comment`,
 * `keyword`, `number`, `variable`, ...). Cutting off only the first segment fits our Monaco
 * theme system naturally.
 *
 * A few outlier segments (`punctuation`/`support`/`entity`/`constant`/`meta`) are
 * normalized to Monaco's familiar names. `meta` is a meaningless grouping scope, so it
 * maps to an empty string and gets default text treatment.
 */
function scopeToToken(scope: string | undefined): string {
  if (!scope) return "";
  const head = scope.split(".")[0];
  switch (head) {
    case "punctuation":
      return "delimiter";
    case "support":
    case "entity":
      return "type";
    case "constant":
      return "number";
    case "meta":
      return "";
    default:
      // string / comment / keyword / number / variable / invalid / markup / ...
      return head;
  }
}

// ---------------------------------------------------------------------------
// Bridge: vscode-textmate grammar → Monaco TokensProvider
// ---------------------------------------------------------------------------

function buildTokensProvider(
  // Grammar is StateStack-aware; vscode-textmate's Grammar type isn't exported
  // as a value, so we accept the loadGrammar return shape directly.
  grammar: NonNullable<Awaited<ReturnType<Registry["loadGrammar"]>>>,
): Monaco.languages.TokensProvider {
  return {
    getInitialState: () => INITIAL as unknown as Monaco.languages.IState,
    tokenize(line, state) {
      const result = grammar.tokenizeLine(line, state as unknown as StateStack);
      return {
        tokens: result.tokens.map((t) => ({
          startIndex: t.startIndex,
          // Pick the deepest (= most specific) scope and map it.
          scopes: scopeToToken(t.scopes[t.scopes.length - 1]),
        })),
        endState: result.ruleStack as unknown as Monaco.languages.IState,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Lazy WASM + Registry init
// ---------------------------------------------------------------------------

let _registryPromise: Promise<Registry> | null = null;

function getRegistry(): Promise<Registry> {
  if (_registryPromise) return _registryPromise;
  _registryPromise = (async () => {
    // The WASM is loaded only once, on the first call. The fetch + arrayBuffer path is the
    // standard approach in the Electron renderer.
    const response = await fetch(onigWasmUrl);
    await loadWASM(await response.arrayBuffer());

    return new Registry({
      onigLib: Promise.resolve({
        createOnigScanner: (sources) => new OnigScanner(sources),
        createOnigString: (s) => new OnigString(s),
      }),
      loadGrammar: async (scopeName) => {
        const spec = TM_LANGUAGES.find((l) => l.scopeName === scopeName);
        // Unregistered scopes (mainly source.shell/js/ts etc. that just embeds) return null,
        // so that block falls back to plaintext. The embedded grammars could be bundled in
        // follow-up work, but that is outside the first scope.
        return spec ? spec.grammar : null;
      },
    });
  })();
  return _registryPromise;
}

// ---------------------------------------------------------------------------
// go.mod / go.sum — hand-written Monarch (not in tm-grammars)
// ---------------------------------------------------------------------------

/**
 * go.mod DSL: module / require / replace / exclude / retract / go / toolchain
 * Directives + semver (v1.2.3, v1.2.3-pre.1+meta) + quoted path strings + comments.
 */
const GOMOD_MONARCH: Monaco.languages.IMonarchLanguage = {
  defaultToken: "",
  keywords: ["module", "require", "replace", "exclude", "retract", "go", "toolchain"],
  tokenizer: {
    root: [
      [/\/\/.*$/, "comment"],
      [/"([^"\\]|\\.)*"/, "string"],
      [/\b(module|require|replace|exclude|retract|go|toolchain)\b/, "keyword"],
      // semver — required after `require` / `replace`. Also matches the /go.mod suffix.
      [/\bv\d+\.\d+\.\d+(?:-[\w.+-]+)?(?:\+[\w.+-]+)?(?:\/go\.mod)?\b/, "number"],
      [/=>/, "operator"],
      [/[()]/, "@brackets"],
      // Module path (github.com/foo/bar form). Handled as an identifier token.
      [/[a-zA-Z0-9_./~-]+/, "identifier"],
      [/[ \t]+/, ""],
    ],
  },
};

/**
 * go.sum: one line = `<module-path> <version> h1:<base64>=`, or a line with a `/go.mod`
 * suffix. Very simple — module path (identifier), version (number),
 * hash (string).
 */
const GOSUM_MONARCH: Monaco.languages.IMonarchLanguage = {
  defaultToken: "",
  tokenizer: {
    root: [
      [/^[^\s]+/, "identifier"],
      [/\bv\d+\.\d+\.\d+(?:-[\w.+-]+)?(?:\+[\w.+-]+)?(?:\/go\.mod)?\b/, "number"],
      [/h1:[A-Za-z0-9+/=]+/, "string"],
      [/[ \t]+/, ""],
    ],
  },
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Registers our supplementary languages with Monaco. Called from initializeEditorServices().
 *
 * - 5 TextMate languages: setTokensProvider after the WASM + grammar load asynchronously.
 *   Registration itself must finish before the user opens the first .toml/.nix/... file
 *   to avoid flicker. It is fire-and-forget, but the WASM loads within tens of ms, so
 *   there is no practical impact. go.mod / go.sum use synchronous Monarch registration.
 *
 * Errors are only reported through console.error and never thrown — a failure to register
 * the supplementary languages must not block the whole editor boot (the other languages work).
 */
export function registerExtraLanguages(monaco: typeof Monaco): void {
  // ---- go.mod / go.sum: synchronous ----
  monaco.languages.register({ id: "gomod", filenames: ["go.mod"] });
  monaco.languages.setMonarchTokensProvider("gomod", GOMOD_MONARCH);
  monaco.languages.register({ id: "gosum", filenames: ["go.sum"] });
  monaco.languages.setMonarchTokensProvider("gosum", GOSUM_MONARCH);

  // ---- 5 TextMate languages: asynchronous. Registering synchronously first makes the file
  // mapping work immediately; tokens are drawn as plaintext until the grammar arrives and
  // are then re-tokenized (standard Monaco behavior). ----
  for (const spec of TM_LANGUAGES) {
    monaco.languages.register({
      id: spec.id,
      extensions: spec.extensions,
      filenames: spec.filenames,
    });
  }

  void (async () => {
    try {
      const registry = await getRegistry();
      for (const spec of TM_LANGUAGES) {
        const grammar = await registry.loadGrammar(spec.scopeName);
        if (!grammar) {
          log.warn(`grammar not loaded: ${spec.scopeName}`);
          continue;
        }
        monaco.languages.setTokensProvider(spec.id, buildTokensProvider(grammar));
      }
    } catch (err) {
      log.error(`TextMate bridge init failed: ${(err as Error).message}`);
    }
  })();
}
