# pattern-i18n — 다국어(i18n) 추가·확장 규약

nexus-code의 i18n 구조와, 새 문자열/언어를 추가할 때 따라야 할 규약. (plan#65에서 구축)

## 스택·구조
- **i18next + react-i18next**. 의존성은 이미 설치됨.
- **이중 프로세스**: main은 격리 인스턴스(`src/main/i18n.ts` — `getMainI18n()`/`getMainT()`/`tryGetMainT()`, `createInstance()`), renderer는 전역 i18next 싱글턴(`src/renderer/i18n.ts`). 인스턴스는 공유 불가(별도 V8) — 같은 리소스를 각자 init.
- **리소스 정본**: `src/shared/i18n/locales/{en,ko}/<ns>.json`. 팩토리 `createI18n({lng})`는 `src/shared/i18n/index.ts`.
- **타입 안전**: `src/shared/i18n/i18next.d.ts`의 CustomTypeOptions가 en 리소스를 기준으로 키 타입을 강제. 빌드(tsc)가 키 누락 검출.

## 네임스페이스 (도메인축, 프로세스축 아님)
| ns | 소비처 |
|---|---|
| `common` | 범용(확인/취소/저장/닫기 등) + 일반 UI(팔레트·workbench·workspace·editor chrome·preview) |
| `menu` | main 네이티브 메뉴 |
| `dialog` | main 파일 다이얼로그 |
| `errors` | 렌더러 surface-error.ts (fs/git code→문구, generic.<category>) |
| `settings` | 설정 다이얼로그 chrome + 5개 패널 |
| `files` | 파일트리·검색·Git UI (components/files) |

신규 ns 추가 시 `i18next.d.ts`와 `createI18n` ns 목록·resources를 함께 갱신. 가급적 common에 수용.

## 키·번역 규약
- 키 네이밍: `<ns>:<subarea>.<key>` 점표기 (예 `errors:fs.NOT_FOUND`, `settings:appearance.language`).
- en/ko 키는 **1:1 대응 필수**. 추가 시 양쪽 동시.
- 보간은 i18next `{{var}}` (단순 문자열 결합 금지 — 어순 차이 대응).
- 복수형: en은 `_one`/`_other`, **한국어는 복수형 없음**(단일형 "파일 {{count}}개").
- 컴포넌트는 `useTranslation(ns)`, 비컴포넌트 .ts는 `i18next.t("ns:key")` 직접(호출 시점 평가라 라이브 전환 반영). 순수 함수(예 git-decoration.ts kindToTooltip)는 t를 주입받지 말고 **소비처(React)에서 번역**.

## 언어 설정·라이브 전환
- 정본: `AppState.language: z.enum(["ko","en"]).optional()` (부재=OS 로케일 추종, 즉시 영속화 금지).
- 부트 기본값: main `app.getLocale()`(whenReady 내), renderer `localStorage["language"] ?? navigator.language`. 부트 경로는 localStorage에 **되쓰지 않음**(OS 추종 유지).
- 전환 흐름: 설정 SegmentedControl→`useLanguageStore.setPreference` → [changeLanguage + localStorage + `appState.set({language})`] → main `appState.set` 핸들러 `onLanguageChanged` → `getMainI18n().changeLanguage` + `installAppMenu(getMainT())` 메뉴 재빌드 + `broadcast("appState","languageChanged")` → 렌더러 `ipcListen`→`hydrate`.
- **hydrate는 appState.set/broadcast를 재유발하지 않음**(피드백 루프 차단). setPreference만 appState.set 호출.
- 네이티브 메뉴는 자동 리렌더 안 됨 — 언어 변경 시 `installAppMenu` 재호출 필수. command 항목 전부 `registerAccelerator:false`라 재설치 안전(OS 가속기 드롭 없음). `buildMenuTemplate`은 순수함수 유지(t 인자 주입, 전역 import 금지).
- 설정 UI 언어 라벨은 **endonym 고정**("English"/"한국어", 번역 안 함). 라이브 전환이라 재시작 배너 없음.

## 주의·함정
- 병렬로 문자열 추출 시 **같은 json(특히 common) 동시 편집은 직렬화**(중간 손상 상태가 다른 에이전트 빌드를 깨뜨림).
- grep 스윕 1회로 불충분 — prop default("Cancel"), JSX 텍스트, 비컴포넌트 .ts 반환값까지 누락 쉬움. 다단계 점검.
- 의도적 영어 예외: LSP 심볼 레이블(SYMBOL_KIND_LABELS), git 기술용어(HEAD/origin/main), MIDI 등 프로토콜명, internalMessage(로그 전용), 언어 endonym.

## 미해결 후속(범위 밖)
- 이중기록(localStorage+appState) 부분 실패 시 사용자 선택 조용한 롤백 — theme.ts와 공유 패턴. set 실패 시 store 롤백+surfaceError 권고.
- `src/shared/security/browser-permissions.ts`의 `permissionLabel()`는 i18n 도입 후 프로덕션 미호출 레거시(UI는 settings:browserPermissions로 번역). 함수/테스트(한국어 기대 3건) 정리 필요.
