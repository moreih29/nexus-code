// Extra language registration for Monaco editor.
//
// Monaco basic-languages 80종은 이미 통째로 들어와 있고, 우리는 그중 매핑이
// 없는 흔한 파일들을 보강한다.
//
// 전략: TextMate grammar(JSON) + vscode-textmate + vscode-oniguruma 스택을
// 인라인 브리지로 monaco.languages.setTokensProvider에 연결한다.
//
//   - VSCode 호환 grammar 5종 (TOML / Makefile / .env / Nix / Justfile)은
//     tm-grammars(shikijs)에서 발췌.
//   - go.mod / go.sum 은 tm-grammars에도 없어 자체 Monarch로 작성. DSL이
//     단순(module / require / replace / exclude / retract / go / toolchain
//     + semver) 해서 ~30줄로 충분.
//
// monaco-editor-textmate 패키지는 Snyk에서 inactive로 분류되어 직접 의존하지
// 않고, 브리지 ~30줄을 여기에 인라인한다. tokensProvider는 TextMate scope의
// 첫 segment만 잘라 Monaco의 기본 토큰 클래스(string/comment/keyword/number/
// variable/...)에 매핑한다. 풀-스코프 테마 매칭은 우리 Monaco 테마 시스템과
// 무관하므로 의도적으로 생략.

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
    // Monaco "ini"가 .env에 매핑되어 있지 않으므로 별도 id로 등록한다.
    // 색칠 수준은 ini와 유사하지만 dotenv grammar는 export 접두사·따옴표 escape
    // 등 dotenv 특화 토큰을 추가로 잡는다.
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
 * TextMate scopes는 "string.quoted.double.toml" 처럼 점-구분 계층 문자열이다.
 * Monaco의 기본 테마 룰은 첫 segment(`string`, `comment`, `keyword`, `number`,
 * `variable` 등)를 알아본다. 첫 segment만 잘라 매핑하면 우리 Monaco 테마
 * 시스템과 자연스럽게 어울린다.
 *
 * 일부 outlier segment(`punctuation`/`support`/`entity`/`constant`/`meta`)는
 * Monaco의 익숙한 이름으로 정규화한다. `meta`는 의미 없는 grouping scope라
 * 빈 문자열로 매핑해 default text 처리.
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
          // 가장 깊이 들어간(=가장 구체적인) scope를 선택해 매핑한다.
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
    // WASM은 첫 호출에서 한 번만 로드. fetch + arrayBuffer 경로는 Electron
    // 렌더러에서 표준적으로 동작한다.
    const response = await fetch(onigWasmUrl);
    await loadWASM(await response.arrayBuffer());

    return new Registry({
      onigLib: Promise.resolve({
        createOnigScanner: (sources) => new OnigScanner(sources),
        createOnigString: (s) => new OnigString(s),
      }),
      loadGrammar: async (scopeName) => {
        const spec = TM_LANGUAGES.find((l) => l.scopeName === scopeName);
        // 미등록 scope(주로 just가 embed하는 source.shell/js/ts 등)는 null을
        // 반환 → 해당 블록은 plaintext로 fallback. 후속 작업으로 embed grammar
        // 까지 묶을 수 있으나 1차 범위 밖.
        return spec ? spec.grammar : null;
      },
    });
  })();
  return _registryPromise;
}

// ---------------------------------------------------------------------------
// go.mod / go.sum — 자체 Monarch (tm-grammars에 없음)
// ---------------------------------------------------------------------------

/**
 * go.mod DSL: module / require / replace / exclude / retract / go / toolchain
 * 디렉티브 + semver(v1.2.3, v1.2.3-pre.1+meta) + 경로 인용 문자열 + 주석.
 */
const GOMOD_MONARCH: Monaco.languages.IMonarchLanguage = {
  defaultToken: "",
  keywords: ["module", "require", "replace", "exclude", "retract", "go", "toolchain"],
  tokenizer: {
    root: [
      [/\/\/.*$/, "comment"],
      [/"([^"\\]|\\.)*"/, "string"],
      [/\b(module|require|replace|exclude|retract|go|toolchain)\b/, "keyword"],
      // semver — required after `require` / `replace`. /go.mod 접미사도 매칭.
      [/\bv\d+\.\d+\.\d+(?:-[\w.+-]+)?(?:\+[\w.+-]+)?(?:\/go\.mod)?\b/, "number"],
      [/=>/, "operator"],
      [/[()]/, "@brackets"],
      // 모듈 경로 (github.com/foo/bar 형태). identifier 토큰으로 처리.
      [/[a-zA-Z0-9_./~-]+/, "identifier"],
      [/[ \t]+/, ""],
    ],
  },
};

/**
 * go.sum: 한 줄 = `<module-path> <version> h1:<base64>=`. 또는 `/go.mod`
 * 접미사가 붙은 라인. 매우 단순 — 모듈 경로(identifier), 버전(number),
 * 해시(string).
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
 * Monaco에 우리 보강 언어들을 등록한다. initializeEditorServices()에서 호출.
 *
 * - TextMate 5종: WASM + grammar 비동기 로드 후 setTokensProvider. 등록 자체는
 *   사용자가 첫 .toml/.nix/... 파일을 열기 전에 끝나야 깜빡임이 없다. fire-and
 *   -forget이지만 WASM 로드 ~수십 ms 안에 완료되므로 실사용 영향 없음.
 * - go.mod / go.sum: 동기 Monarch 등록.
 *
 * 오류는 console.error로만 보고하고 throw하지 않는다 — 보강 언어 등록 실패가
 * 전체 에디터 부팅을 막아선 안 됨(타 언어들은 모두 정상 동작).
 */
export function registerExtraLanguages(monaco: typeof Monaco): void {
  // ---- go.mod / go.sum: 동기 ----
  monaco.languages.register({ id: "gomod", filenames: ["go.mod"] });
  monaco.languages.setMonarchTokensProvider("gomod", GOMOD_MONARCH);
  monaco.languages.register({ id: "gosum", filenames: ["go.sum"] });
  monaco.languages.setMonarchTokensProvider("gosum", GOSUM_MONARCH);

  // ---- TextMate 5종: 비동기. 등록만 먼저 동기로 해두면 파일 매핑은 즉시
  // 작동하고, grammar 도착 전 토큰은 plaintext로 그려졌다가 grammar 도착 후
  // re-tokenize 된다(Monaco 표준 동작). ----
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
