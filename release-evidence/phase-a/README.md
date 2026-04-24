# release-evidence/phase-a

## 목적

영구 마일스톤 검증 증거 아카이브. 각 Phase·마일스톤의 PASS 판정 근거가 되는 테스트 출력, 체크리스트, 스크린샷 등 불변 기록을 보관한다.

## 불변성 원칙

이 디렉터리에 기록된 증거 파일은 수정·삭제·이동을 금지한다. 오기재·오류 발견 시 해당 런 디렉터리를 수정하지 않는다. 정정이 필요하면 새 타임스탬프 디렉터리를 생성하고 정정 사유를 해당 디렉터리 내 노트에 명시한다.

## 네이밍 규약

런 디렉터리 형식: `<ISO8601-KST>_<task|scope>/`

예: `2026-04-24T15-12-00KST_task11`

스코프 공통 파일(phase 전체에 걸친 체크리스트 등)은 phase 루트에 직접 둔다.

## 현재 보관 항목

| 경로 | 내용 |
|------|------|
| `2026-04-24T15-12-00KST_task11/` | Phase A PASS 증거 — 자동 게이트 및 수동 통합 테스트 출력 47개 파일 (2026-04-24) |
| `manual-integration-checklist.md` | Phase A 수동 통합 체크리스트 — 3워크스페이스·IME·재시작 복원 확인 절차 |

## 향후 확장

이후 마일스톤 증거는 저장소 루트의 `release-evidence/` 하위에 같은 패턴으로 추가한다.

| 마일스톤 | 대상 경로 |
|----------|-----------|
| M3 Harness Observer (E3) | `release-evidence/m3/` |
| M4 Editor + LSP (E4) | `release-evidence/m4/` |
| M5 Preview (E5) | `release-evidence/m5/` |
| M6 v0.1 Release | `release-evidence/m6/` |

각 경로 내 런 디렉터리는 동일한 `<ISO8601-KST>_<task|scope>/` 형식을 따른다.

## 로드맵 연계

`.nexus/context/roadmap.md` Phase A 행이 이 디렉터리를 공식 증거 경로로 직접 인용한다.
