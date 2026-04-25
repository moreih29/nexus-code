# Zustand selector 안정성

## 언제 쓰는 패턴

Zustand `useStore(store, selector)`에서 selector가 매 호출마다 **새 객체/배열**을 반환하면 React 19의 `useSyncExternalStore` + StrictMode concurrent render 경로에서 무한 loop 또는 "getSnapshot should be cached" 경고 발생.

## 증상

- console에서 `"The result of getSnapshot should be cached to avoid an infinite loop"` 반복
- 또는 `"Maximum update depth exceeded"` error
- commit 848855e 시점 CommandPalette.tsx가 `keyboardRegistryStore.getState().getCommands()`를 useStore selector 내부에서 호출 → 매 render마다 새 배열 → 무한 re-render → black screen

## 안전한 패턴

### 1. Primitive 또는 stable reference 반환

```ts
// OK — primitive
const count = useStore(store, (state) => state.count);

// OK — state에 이미 저장된 array/object reference
const items = useStore(store, (state) => state.items);

// BAD — 매번 새 배열 생성
const commands = useStore(store, (state) => Object.values(state.commandMap));
```

### 2. 파생 값이 필요하면 store 내부에 저장

```ts
// store 정의
{
  commandMap: {},
  commandList: [],   // 별도 필드로 관리
  addCommand: (cmd) => set((state) => ({
    commandMap: { ...state.commandMap, [cmd.id]: cmd },
    commandList: [...state.commandList, cmd],  // 동시 업데이트
  })),
}

// component
const commands = useStore(store, (state) => state.commandList);
```

### 3. 외부에서 직접 getState() 호출

re-render 트리거가 필요 없는 read-only 접근:

```ts
// subscribe에서 안정적으로 호출
const commands = keyboardRegistryStore.getState().commandList;
```

### 4. shallow equality helper

배열/객체 파생이 불가피하면:

```ts
import { useShallow } from "zustand/react/shallow";

const commands = useStore(store, useShallow((state) => Object.values(state.commandMap)));
```

## 금지 패턴

```ts
// 1. selector 내부에서 배열 생성
useStore(store, (state) => state.ids.map((id) => state.map[id]));

// 2. selector 내부에서 필터링
useStore(store, (state) => state.items.filter((x) => x.active));

// 3. selector 내부에서 sort
useStore(store, (state) => [...state.items].sort());

// 4. selector 내부에서 Object.values/keys
useStore(store, (state) => Object.values(state.map));
```

위 모두 매 호출마다 새 reference 반환 → infinite loop.

## 우리 경험 (commit 9a2be79)

`CommandPalette.tsx`에서 `keyboardRegistryStore`의 `getCommands()` helper를 useStore selector 안에서 호출. helper는 매번 `Object.values(...)` 수행. React 19 concurrent render에서 첫 commit 중 다시 snapshot 비교 호출되면서 새 배열 반환 → 불일치 감지 → re-render 스케줄 → 또 새 배열 → 무한 루프 → 메인 스레드 blocking → 검은 화면.

**해결**:
- `getCommands()` helper 사용을 selector 경로에서 제거
- 대신 store 내부에 `commandList` array를 실제 state로 저장
- mutation 시 `commandMap`·`commandList` 동시 업데이트

```ts
// before (broken)
const commands = useStore(store, (state) => state.getCommands());

// after (stable)
const commands = useStore(store, (state) => state.commandList);
```

## 체크리스트

새 Zustand selector 작성 시:

- [ ] selector가 primitive 또는 이미 state에 저장된 reference를 반환하는가?
- [ ] 파생 연산(`.map`, `.filter`, `.sort`, `Object.values`)이 selector 안에 있는가? → 있으면 위험
- [ ] React 19 + StrictMode에서 dev 20초 스모크 시 `getSnapshot should be cached` 경고가 있는가?
- [ ] `useShallow` 적용이 필요하면 명시적으로 사용했는가?

## 외부 참고

- Zustand docs: https://zustand.docs.pmnd.rs/guides/prevent-rerenders-with-use-shallow
- React `useSyncExternalStore` 제약: snapshot은 mutation 없는 한 referentially stable해야 함
