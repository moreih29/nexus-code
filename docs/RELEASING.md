# NexusCode — Release Guide

릴리스는 항상 `develop`에서 준비해 `main`으로 승격한 뒤, GitHub Release를 발행해
자동 빌드를 트리거하는 순서로 진행한다. 아래 0 → 4 단계를 그대로 따른다.

## 0. 브랜치 모델 & 버전 정책

### 브랜치

| 브랜치 | 역할 |
|---|---|
| `develop` | 통합 브랜치. 모든 기능/수정이 여기 쌓인다. |
| `main` | 릴리스 브랜치. 태그와 GitHub Release는 여기서만 만든다. |

- **CI (`ci.yml`)** 는 `main` 으로의 **PR / push 에서만** 돈다 (typecheck · lint · test, electron-builder 미실행). develop 자체에는 게이트가 없으므로, 품질 게이트는 `develop → main` PR에서 통과시킨다.
- **Release (`release.yml`)** 는 **GitHub Release 가 created** 될 때 트리거된다.

### 버전 (SemVer, 1.0 이전)

`major` 는 1.0 전까지 `0` 으로 고정한다. 직전 태그 이후의 커밋을 기준으로:

| 변경 | bump |
|---|---|
| 사용자 기능 추가 (`feat`) 가 하나라도 있음 | **minor** (`0.4.0 → 0.5.0`) |
| 수정/리팩터만 (`fix`/`refactor`/`chore`/`test`) | **patch** (`0.4.0 → 0.4.1`) |
| 호환성 깨지는 변경 (마이그레이션 필요) | **minor** + 릴리스 노트에 명시 (1.0 전까지 major 안 올림) |

---

## 1. 릴리스 준비 (develop)

1. **릴리스 노트 초안 + 버전 결정**
   직전 태그 이후 커밋을 훑어 노트를 분류하고 bump 폭을 정한다.
   ```bash
   git log v0.4.0..develop --oneline
   ```
   `feat` 가 보이면 minor, 아니면 patch (위 표).

2. **Version bump**
   `package.json` 의 `version` 필드를 SemVer 에 맞게 올리고 커밋한다.
   ```
   chore: bump version to 0.5.0
   ```
   > 이 커밋이 나중에 태그가 가리킬 대상이다 — 반드시 bump 를 먼저 하고, 그 커밋을 main 으로 올린 뒤 태깅한다.

---

## 2. main 승격

3. **PR: `develop → main`**
   PR을 열면 `ci.yml` 이 돈다. develop 이 main 보다 앞서 있고 충돌이 없으면 그대로 머지 가능하다.

4. **CI green 확인 후 머지**
   PR의 CI 가 모두 통과하면 머지한다. 머지된 main push 로 CI 가 한 번 더 green 인지 확인한다.

---

## 3. Release 발행 (GitHub)

5. **Draft a new release**
   저장소 → **Releases** → **Draft a new release**.

6. **Tag 및 Release body 작성**
   - Tag: `v0.5.0` 형식 (package.json `version` 과 일치). **Target 은 `main`** — bump 커밋을 가리키는지 확인.
   - Title: `v0.5.0` 또는 `v0.5.0 — <한 줄 요약>`.
   - Body: 아래 **릴리스 노트 체크리스트** 순서로 작성.

7. **Pre-release 토글**
   - 베타 빌드면 **Set as a pre-release** 체크 (→ `beta` 채널 수신 대상).
   - 정식 릴리스면 체크 해제 (→ `stable` 채널).
   - 이 설정이 `NEXUS_CHANNEL` (`stable` / `beta`) 과 업데이트 수신 대상을 결정한다.

8. **Publish release**
   **Publish release** 클릭 → `release.yml` 자동 트리거.

---

## 4. 배포 검증

`release.yml` 의 2-job 파이프라인이 자동 실행된다:
- **build-agent** (`ubuntu-latest`): Go 에이전트 크로스컴파일 + Node runtime + LSP 번들 산출 (OS 독립).
- **package** (`macos-14`, Apple Silicon arm64): native rebuild 후 electron-builder 로 DMG / ZIP 패키징, `--publish never` 로 산출만 하고 별도 step 의 `gh release upload --clobber` 로 첨부. **arm64 단일 빌드만 제공** — Intel(x64) 정식 배포는 없으며, Intel 사용자는 [`INSTALL.md`](INSTALL.md#self-build) 의 self-build 절차를 따른다.

9. **자산 확인**
   GitHub Release 에 아래가 모두 첨부됐는지 확인한다:
   ```
   NexusCode-X.Y.Z-arm64.dmg
   NexusCode-X.Y.Z-arm64.zip
   latest-mac.yml
   ```

10. **설치 확인**
    arm64 DMG 를 설치해 앱 버전과 업데이트 채널이 올바른지 확인한다.

---

## 릴리스 노트 체크리스트

릴리스 노트는 GitHub Release body 에 직접 작성한다. 아래 카테고리로 분류한다.

### Added
사용자가 새롭게 쓸 수 있는 기능. 신규 UI 컴포넌트, 명령, 설정 항목 등.

### Changed
기존 동작 변경. 기본값 변경, 레이아웃/UX 재설계, 명령어·키 바인딩 변경 등.

### Fixed
버그 수정. 재현 조건과 수정 결과를 함께 적으면 유용하다.

### Protocol & Remote 영향
아래 중 해당하는 것이 있으면 반드시 명시한다.
- **Agent protocol version**: `src/main/features/` 또는 Go 에이전트의 프로토콜 버전이 바뀐 경우.
- **NEXUS_REMOTE_AGENT_ROOT 변경**: escape hatch 경로 로직이 바뀐 경우.
- **첫 SSH 부팅 재업로드 필요**: 원격 에이전트 바이너리가 업데이트되어 기존 SSH 워크스페이스에서 재업로드가 필요한 경우.
- **prune / 캐시 정책 변경**: `~/.nexus-code/` 또는 `~/.nexus-code-beta/` 내 파일 구조가 변경된 경우.
