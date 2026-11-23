import type * as Monaco from "monaco-editor";
import dotenvGrammar from "tm-grammars/grammars/dotenv.json";
import justGrammar from "tm-grammars/grammars/just.json";
import makeGrammar from "tm-grammars/grammars/make.json";
import nixGrammar from "tm-grammars/grammars/nix.json";
import tomlGrammar from "tm-grammars/grammars/toml.json";
import { loadWASM, OnigScanner, OnigString } from "vscode-oniguruma";
import onigWasmUrl from "vscode-oniguruma/release/onig.wasm?url";
import type { IRawGrammar, StateStack } from "vscode-textmate";
import { INITIAL, Registry } from "vscode-textmate";
import { createLogger } from "../../../../shared/log/renderer";

interface TmLangSpec {
  id: string;
  scopeName: string;
  grammar: IRawGrammar;
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
      return head;
  }
}

function buildTokensProvider(
  grammar: NonNullable<Awaited<ReturnType<Registry["loadGrammar"]>>>,
): Monaco.languages.TokensProvider {
  return {
    getInitialState: () => INITIAL as unknown as Monaco.languages.IState,
    tokenize(line, state) {
      const result = grammar.tokenizeLine(line, state as unknown as StateStack);
      return {
        tokens: result.tokens.map((t) => ({
          startIndex: t.startIndex,
          scopes: scopeToToken(t.scopes[t.scopes.length - 1]),
        })),
        endState: result.ruleStack as unknown as Monaco.languages.IState,
      };
    },
  };
}

let _registryPromise: Promise<Registry> | null = null;

function getRegistry(): Promise<Registry> {
  if (_registryPromise) return _registryPromise;
  _registryPromise = (async () => {
    const response = await fetch(onigWasmUrl);
    await loadWASM(await response.arrayBuffer());

    return new Registry({
      onigLib: Promise.resolve({
        createOnigScanner: (sources) => new OnigScanner(sources),
        createOnigString: (s) => new OnigString(s),
      }),
      loadGrammar: async (scopeName) => {
        const spec = TM_LANGUAGES.find((l) => l.scopeName === scopeName);
        return spec ? spec.grammar : null;
      },
    });
  })();
  return _registryPromise;
}

const GOMOD_MONARCH: Monaco.languages.IMonarchLanguage = {
  defaultToken: "",
  keywords: ["module", "require", "replace", "exclude", "retract", "go", "toolchain"],
  tokenizer: {
    root: [
      [/\/\/.*$/, "comment"],
      [/"([^"\\]|\\.)*"/, "string"],
      [/\b(module|require|replace|exclude|retract|go|toolchain)\b/, "keyword"],
      [/\bv\d+\.\d+\.\d+(?:-[\w.+-]+)?(?:\+[\w.+-]+)?(?:\/go\.mod)?\b/, "number"],
      [/=>/, "operator"],
      [/[()]/, "@brackets"],
      [/[a-zA-Z0-9_./~-]+/, "identifier"],
      [/[ \t]+/, ""],
    ],
  },
};

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

export function registerExtraLanguages(monaco: typeof Monaco): void {
  monaco.languages.register({ id: "gomod", filenames: ["go.mod"] });
  monaco.languages.setMonarchTokensProvider("gomod", GOMOD_MONARCH);
  monaco.languages.register({ id: "gosum", filenames: ["go.sum"] });
  monaco.languages.setMonarchTokensProvider("gosum", GOSUM_MONARCH);

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
