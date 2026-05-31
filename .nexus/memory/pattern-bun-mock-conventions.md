# pattern: Bun mock 컨벤션

> 목적: bun:test에서 `mock.module`의 process-global 오염을 줄이고, editor 도메인 테스트를 파일 간 독립적으로 유지한다.
> 적용 범위: `tests/**`와 테스트 가능성을 위해 seam을 노출하는 `src/renderer/services/editor/**` 모듈.

---

## 룰 요약

1. **DI-first가 기본값이고 `mock.module`은 leaf-only로 제한한다.** 프로젝트 내부 모듈은 먼저 `*Deps` / `default*Deps` seam을 주입하고, `mock.module`은 IPC, Electron, toast, Monaco singleton처럼 경계가 작고 안정적인 leaf 모듈에만 기본 사용한다.
2. **mocking이 불가피하면 real export를 spread한다.** 모듈 전체를 빈 stub으로 갈아끼우지 말고 `...realExports` 뒤에 필요한 export만 override한다.
3. **editor 도메인 모듈은 `*Deps` / `default*Deps` seam을 노출한다.** 새 테스트 대상이 editor 내부 의존성을 바꾸어야 하면 production default와 test deps를 분리한다.
4. **테스트 파일명은 `<module>-<aspect>.test.ts`를 쓴다.** 한 모듈의 여러 관심사는 파일명에서 aspect로 분리한다.
5. **Electron 등 공유 모듈은 `tests/setup.ts` canonical hermetic stub에만 의존한다.** 파일별 부분 electron mock(예: `webContents`만 정의하고 `ipcMain` 누락) 신규 작성을 금지한다. 파일이 추가로 설치하는 mock은 `afterEach(() => mock.restore())`로 파일 경계 내 복원한다.

---

## Rule 1 — DI-first / leaf-only `mock.module`

Bun의 `mock.module`은 process-global이다. 한 테스트 파일의 mock이 같은 프로세스에서 나중에 import되는 다른 테스트 파일의 module surface를 오염시킬 수 있다.

따라서 editor 내부 의존성은 DI seam을 우선한다.

```ts
// src/renderer/services/editor/example-feature.ts
import { acquireModel, releaseModel } from "./model-cache";
import type { EditorInput } from "./types";

export interface ExampleFeatureDeps {
  acquireModel: (input: EditorInput) => Promise<unknown>;
  releaseModel: (input: EditorInput) => void;
}

export const defaultExampleFeatureDeps: ExampleFeatureDeps = {
  acquireModel,
  releaseModel,
};

export async function runExampleFeature(
  input: EditorInput,
  deps: ExampleFeatureDeps = defaultExampleFeatureDeps,
): Promise<void> {
  await deps.acquireModel(input);
  deps.releaseModel(input);
}
```

```ts
// tests/unit/renderer/services/editor/example-feature-flow.test.ts
import { describe, expect, mock, test } from "bun:test";
import type { ExampleFeatureDeps } from "../../../../../src/renderer/services/editor/example-feature";
import { runExampleFeature } from "../../../../../src/renderer/services/editor/example-feature";

const acquireModel = mock(() => Promise.resolve({ phase: "ready" }));
const releaseModel = mock(() => {});

const deps: ExampleFeatureDeps = {
  acquireModel,
  releaseModel,
};

test("acquires and releases the target model", async () => {
  const input = { workspaceId: "ws-1", filePath: "/workspace/a.ts" };

  await runExampleFeature(input, deps);

  expect(acquireModel).toHaveBeenCalledWith(input);
  expect(releaseModel).toHaveBeenCalledWith(input);
});
```

`mock.module`은 아래처럼 leaf dependency에만 기본 허용한다.

```ts
import { mock } from "bun:test";

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCall: mock(() => Promise.resolve(null)),
  ipcListen: mock(() => () => {}),
}));
```

---

## Rule 2 — spread-real-exports when mocking

모듈 mock이 불가피하면 실제 export를 먼저 import하고 spread한 뒤 필요한 export만 override한다.

```ts
import { mock } from "bun:test";

const realModelCache = await import(
  "../../../../../src/renderer/services/editor/model-cache"
);

const getResolvedModel = mock(() => ({
  model: { getValue: () => "content" },
  cacheUri: "file:///workspace/a.ts",
  workspaceId: "ws-1",
  filePath: "/workspace/a.ts",
  languageId: "typescript",
  readOnly: true,
}));

mock.module("../../../../../src/renderer/services/editor/model-cache", () => ({
  ...realModelCache,
  getResolvedModel,
}));
```

**금지 패턴**

```ts
mock.module("../../../../../src/renderer/services/editor/model-cache", () => ({
  getResolvedModel,
  // acquireModel, releaseModel, subscribeOnRelease 등 다른 export가 사라진다.
}));
```

---

## Rule 3 — editor module seam naming

editor 도메인 모듈이 외부 효과나 내부 service를 호출하면 아래 이름을 사용한다.

- interface: `<Feature>Deps`
- production default: `default<Feature>Deps`
- public function parameter: `deps: <Feature>Deps = default<Feature>Deps`

예: `PreAcquireDeps`, `defaultPreAcquireDeps`, `preAcquireLocationModels(..., deps = defaultPreAcquireDeps)`.

선행 적용 위치: `src/renderer/services/editor/lsp-result-preacquire.ts:47-62`에서 `PreAcquireDeps`와 `defaultPreAcquireDeps`를 정의하고, `src/renderer/services/editor/lsp-result-preacquire.ts:87-91`에서 default deps parameter를 사용한다.

이 seam은 테스트 편의를 위한 전역 mock 회피 장치다. production caller는 기본값을 쓰므로 호출부 변경을 최소화한다.

---

## Rule 4 — test filename convention

테스트 파일명은 `<module>-<aspect>.test.ts`로 쓴다.

- 좋은 예: `model-cache-release.test.ts`
- 좋은 예: `model-cache-acquire-external.test.ts`
- 좋은 예: `lsp-result-preacquire.test.ts`
- 피할 예: `editor-services.test.ts`에 여러 editor 관심사 누적
- 피할 예: `misc.test.ts`, `plan-adversarial.test.ts`

한 파일이 여러 aspect를 검증하기 시작하면 aspect별 파일로 분리한다.

---

## Rule 5 — Electron canonical hermetic stub

`electron` 모듈처럼 여러 테스트 파일이 공유하는 모듈을 파일별로 부분 mock하면 process-global 오염이 순서 의존 버그를 만든다. 예를 들어 한 파일에서 `webContents`만 정의한 partial mock이 전역에 설치된 채로 다음 파일이 실행되면, 그 파일은 `ipcMain`이 없는 오염된 상태를 이어받는다.

**규칙**: Electron 및 이에 준하는 공유 모듈은 `tests/setup.ts`의 **canonical hermetic stub**에 의존한다.

- Canonical stub은 전역 preload 단계(`setup.ts`)에서 단 한 번 설치된다.
- 모든 참조 surface(`ipcMain` · `ipcRenderer` · `webContents` · `app` · `BrowserWindow` 등)를 갖춘 단일 정의다.
- 파일별 부분 electron mock 신규 작성은 금지한다.
- 파일이 stub 위에 추가로 설치한 mock · spy는 `afterEach(() => mock.restore())`로 파일 경계 안에서 되돌린다.

```ts
// tests/setup.ts — canonical stub 부분 발췌 (실제 surface 기준, 일부 생략)
mock.module("electron", () => ({
  app: {
    isPackaged: false,
    getPath: (_name: string): string => "/tmp/nexus-test",
    getVersion: (): string => "0.0.0-test",
    getName: (): string => "nexus-test",
    getLocale: (): string => "en",
    quit: (): void => {},
  },
  ipcMain: {
    on: (_channel: string, _listener: unknown): void => {},
    handle: (_channel: string, _listener: unknown): void => {},
    removeHandler: (_channel: string): void => {},
    removeAllListeners: (_channel?: string): void => {},
    emit: (_channel: string, ..._args: unknown[]): boolean => false,
  },
  ipcRenderer: {
    invoke: async (_channel: string, ..._args: unknown[]): Promise<unknown> => null,
    on: (_channel: string, _listener: unknown): void => {},
    send: (_channel: string, ..._args: unknown[]): void => {},
    removeListener: (_channel: string, _listener: unknown): void => {},
  },
  webContents: {
    getAllWebContents: (): unknown[] => [],
  },
  BrowserWindow: {
    getFocusedWindow: (): null => null,
    getAllWindows: (): unknown[] => [],
  },
}));
```

```ts
// tests/unit/some-feature.test.ts — 추가 spy는 afterEach로 복원
import { afterEach, mock, test, expect } from "bun:test";
import { ipcMain } from "electron"; // canonical stub에서 옴

afterEach(() => {
  mock.restore(); // 이 파일이 추가로 설치한 mock만 되돌림
});

test("registers ipc handler on init", () => {
  // ...
  expect(ipcMain.handle).toHaveBeenCalledWith("channel:name", expect.any(Function));
});
```

**금지 패턴**

```ts
// ❌ 파일 안에서 partial electron mock 재설치
mock.module("electron", () => ({
  webContents: { send: mock(() => {}) },
  // ipcMain, app, BrowserWindow 누락 → 다음 파일 오염
}));
```

→ `pattern-test-design.md` §3 격리 절 참조.

---

## 정당화 사례

아래 표는 각 컨벤션을 적용해야 하는 기존 테스트 사례와 해당 룰을 연결한다.

| 사례 | 관찰 | 적용 룰 |
|------|------|---------|
| `lsp-result-preacquire.ts` | `model-cache`의 `acquireModel` / `releaseModel`을 `mock.module`로 바꾸면 다른 editor 테스트가 오염될 수 있어 `PreAcquireDeps`로 우회 | Rule 1 / 3 |
| `model-cache-release.test.ts` | `lsp-bridge`를 mock해야 하지만 다른 export surface가 필요하므로 `...realLspBridge` 후 일부 함수만 override | Rule 2 |
| `model-cache-acquire-external.test.ts` | `model-entry`, `load-external-entry` 등 필요한 export만 override하고 나머지는 real export 유지 | Rule 2 |
| `save-service.test.ts` | read-only guard 분기에서 실제로 필요한 `dirty-tracker`, `model-cache`, `ipc/client`, `toast`만 mock하고 나머지 editor 의존성은 건드리지 않음 | Rule 1 / 2 |
| 파일명 분리 | `model-cache-release.test.ts`와 `model-cache-acquire-external.test.ts`처럼 같은 모듈도 release / acquire-external aspect를 분리 | Rule 4 |

---

## 적용 체크리스트

- [ ] 내부 editor dependency를 mock하려는가? 먼저 `*Deps` seam으로 바꿀 수 있는지 확인한다.
- [ ] `mock.module` 대상이 leaf module인가? 아니면 중단하고 DI 또는 spread-real-exports를 쓴다.
- [ ] mock factory가 `...realExports`를 포함하는가?
- [ ] mock은 module-under-test import보다 먼저 선언됐는가?
- [ ] 파일명이 `<module>-<aspect>.test.ts`인가?
- [ ] Electron 등 공유 모듈은 `tests/setup.ts` canonical stub에 의존하는가? (파일별 partial electron mock을 새로 작성하지 않았는가?)
- [ ] 파일이 추가로 설치한 mock은 `afterEach(() => mock.restore())`로 복원하는가?
