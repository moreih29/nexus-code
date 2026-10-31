# NexusCode — Release Guide

릴리스는 항상 `develop`에서 준비해 `main`으로 승격한 뒤, GitHub Release를 발행해
자동 빌드를 트리거하는 순서로 진행한다. 아래 0 → 5 단계를 그대로 따른다.

## 0. 브랜치 모델 & 버전 정책

### 브랜치

| 브랜치 | 역할 |
|---|---|
| `develop` | 통합 브랜치. 모든 기능/수정이 여기 쌓인다. |
| `main` | 릴리스 브랜치. 태그와 GitHub Release는 여기서만 만든다. |

- **CI (`ci.yml`)** 는 `main` · `develop` 으로의 **PR** 과 `main` **push** 에서 돈다 (typecheck · lint · test, electron-builder 미실행). macOS · Ubuntu · Windows 러너에서 각각 돌며, 세 OS 모두 통과해야 한다. develop push 에는 게이트가 없으므로, 품질 게이트는 PR 에서 통과시킨다.
- **Release (`release.yml`)** 는 **GitHub Release 가 created** 될 때 트리거된다.

### 서명 인증서

릴리스 빌드는 자체 서명 인증서 **NexusCode Release Signing** 으로 서명한다 (`scripts/sign-mac.cjs`). 설치된 앱의 앱 안 업데이트는 새 버전이 **같은 인증서**로 서명됐을 때만 된다 — 인증서가 바뀌면 그 전 버전 사용자는 모두 한 번 `.dmg` 로 수동 설치해야 한다.

| 위치 | 내용 |
|---|---|
| Secret `MAC_SIGNING_CERT_P12` | 인증서 `.p12` 의 base64 |
| Secret `MAC_SIGNING_CERT_PASSWORD` | `.p12` 비밀번호 |
| `release.yml` 의 `NEXUS_MAC_SIGN_IDENTITY` | 인증서 SHA-1 (`A1FC28A2…CABD0`). Secret 의 인증서가 이와 다르면 릴리스가 실패한다 |

- Secret 은 다시 읽을 수 없다. 분실·삭제 시 새 인증서를 만들어 두 Secret 과 `NEXUS_MAC_SIGN_IDENTITY` 를 함께 바꾸고, 릴리스 노트에 **수동 설치 필요**를 명시한다.
- 인증서는 2056-10 에 만료된다.

### Microsoft Store 제출 자격 증명

`release.yml` 의 `submit-store` 는 Store Developer CLI(`msstore`)로 Store 에 제출한다. CLI 는 Partner Center 에 **Manager (Windows)** 역할로 등록한 Microsoft Entra 애플리케이션 `NexusCode Store CLI` 로 로그인한다 (Partner Center → 계정 설정 → 사용자 관리 → Microsoft Entra 애플리케이션). Manager 라 계정의 모든 앱을 제출할 수 있다.

| 위치 | 내용 |
|---|---|
| Secret `MSSTORE_TENANT_ID` | Partner Center 에 연결한 Entra 테넌트 ID |
| Secret `MSSTORE_CLIENT_ID` | 위 애플리케이션의 클라이언트 ID |
| Secret `MSSTORE_CLIENT_SECRET` | 그 애플리케이션의 키 (Partner Center 에서 **새 키 추가**) |
| Secret `MSSTORE_SELLER_ID` | 계정 설정 → 조직 프로필 → 법적 정보의 Seller ID |
| `scripts/store-submit.ts` 의 `PRODUCT_ID` | NexusCode 의 Store 제품 ID `9P04CSF0J5ZD` |

- 키에는 만료일이 있다. 만료 전에 같은 화면에서 새 키를 만들어 `MSSTORE_CLIENT_SECRET` 을 바꾸고, 옛 키를 지운다. 노출됐을 때도 그 키만 지우면 된다.
- 로컬에서 CLI 를 쓰려면 [릴리스](https://github.com/microsoft/msstore-cli/releases)의 `MSStoreCLI-win-x64.zip` 을 풀고, 위 값으로 `msstore reconfigure --tenantId … --sellerId … --clientId … --clientSecret …` 를 한 번 실행한다. 인자 없이 실행하면 Entra 계정 로그인 창을 띄우는데, 이 창이 뜨지 않을 수 있다.

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

3. **Store 새 기능 문구**
   `build/store-release-notes.json` 의 `version` 을 새 버전으로 바꾸고, Store 등록 정보의 **새 기능** 에 들어갈 한국어(`ko-kr`) · 영어(`en-us`) 문구를 쓴다. Windows 사용자에게 해당하는 변경만, 각 1500자 안으로. Store 등록 정보의 언어마다 문구가 있어야 하고, 문구의 `version` 이 `package.json` 과 다르면 단위 테스트와 `submit-store` 가 실패한다.

---

## 2. main 승격

4. **PR: `develop → main`**
   PR을 열면 `ci.yml` 이 돈다. develop 이 main 보다 앞서 있고 충돌이 없으면 그대로 머지 가능하다.

5. **CI green 확인 후 머지**
   PR의 CI 가 모두 통과하면 머지한다. 머지된 main push 로 CI 가 한 번 더 green 인지 확인한다.

---

## 3. Release 발행 (GitHub)

6. **Draft a new release**
   저장소 → **Releases** → **Draft a new release**.

7. **Tag 및 Release body 작성**
   - Tag: `v0.5.0` 형식 (package.json `version` 과 일치). **Target 은 `main`** — bump 커밋을 가리키는지 확인.
   - Title: `v0.5.0` 또는 `v0.5.0 — <한 줄 요약>`.
   - Body: 아래 **릴리스 노트 체크리스트** 순서로 작성.

8. **Pre-release 토글**
   - 베타 빌드면 **Set as a pre-release** 체크 (→ `beta` 채널 수신 대상).
   - 정식 릴리스면 체크 해제 (→ `stable` 채널).
   - 이 설정이 `NEXUS_CHANNEL` (`stable` / `beta`) 과 업데이트 수신 대상을 결정한다.

9. **Publish release**
   **Publish release** 클릭 → `release.yml` 자동 트리거.

---

## 4. 배포 검증

`release.yml` 의 5-job 파이프라인이 자동 실행된다:
- **build-agent** (`ubuntu-latest`): Go 에이전트 크로스컴파일 + Node runtime + LSP 번들 산출 (OS 독립). Node runtime tarball 은 Actions 캐시(`node-runtime-<버전>`, main 의 CI 가 채움)에서 먼저 찾고, 없을 때만 nodejs.org 에서 받는다. 어느 쪽이든 nodejs.org 의 `SHASUMS256.txt` 와 SHA-256 이 맞아야 쓴다.
- **package** (`macos-15`, Apple Silicon arm64): native rebuild 후 electron-builder 로 DMG / ZIP 패키징, `--publish never` 로 산출만 하고 별도 step 의 `gh release upload --clobber` 로 첨부. **arm64 단일 빌드만 제공** — Intel(x64) 정식 배포는 없으며, Intel 사용자는 [`INSTALL.md`](INSTALL.md#self-build) 의 self-build 절차를 따른다.
- **package-linux** (`ubuntu-latest` x64, `ubuntu-24.04-arm` arm64): 아키텍처마다 AppImage / deb 를 만들어 같은 방식으로 첨부한다. Linux 는 서명하지 않는다 — 앱 안 업데이트는 피드 파일(`latest-linux*.yml`)의 sha512 로만 검증한다.
- **package-windows** (`windows-latest` x64): Microsoft Store 에 낼 AppX 를 만든다. 서명은 Store 가 하므로 서명하지 않은 AppX 라, Release 자산이 아니라 워크플로 아티팩트 `msstore-appx-vX.Y.Z` 로 30일 남긴다.
- **submit-store** (`windows-latest`, 정식 릴리스만): 그 AppX 를 Store 에 제출한다 (5단계).

10. **서명 확인**
   `Verify the signature` step 이 통과했는지 본다 (앱이 릴리스 인증서로 서명됐는지 검사).

11. **자산 확인**
   GitHub Release 에 아래가 모두 첨부됐는지 확인한다:
   ```
   NexusCode-X.Y.Z-arm64.dmg
   NexusCode-X.Y.Z-arm64.zip
   latest-mac.yml
   NexusCode-X.Y.Z-x86_64.AppImage
   NexusCode-X.Y.Z-amd64.deb
   latest-linux.yml
   NexusCode-X.Y.Z-arm64.AppImage
   NexusCode-X.Y.Z-arm64.deb
   latest-linux-arm64.yml
   ```

12. **설치 확인**
    arm64 DMG 를 설치해 앱 버전과 업데이트 채널이 올바른지 확인한다. 이전 버전이 설치돼 있으면 앱 안 **업데이트** 로 새 버전이 설치되는지도 확인한다. Linux 머신이 있으면 deb 설치와 AppImage 실행도 확인한다.

---

## 5. Microsoft Store 제출

Store 에는 정식 릴리스만 낸다 (pre-release 는 내지 않는다). Store 가 설치본을 직접 업데이트하므로, Store 설치본은 GitHub 의 새 버전을 확인하지 않는다.

`submit-store` 가 제출까지 한다 (`scripts/store-submit.ts`). 마지막으로 게시된 제출을 바탕으로 새 제출을 만들고, 패키지를 이번 AppX 로 바꾸고, 등록 정보 언어마다 **새 기능** 을 `build/store-release-notes.json` 의 문구로 바꾼 뒤 인증에 낸다. 설명 · 스크린샷 · 가격 · 인증 메모 같은 나머지는 이전 제출의 값을 그대로 쓴다. Partner Center 에 만들다 만 제출이 있으면 지우고 새로 만든다.

13. **제출 확인**
    `submit-store` 의 마지막 줄이 `Submitted NexusCode-X.Y.Z-x64.appx for certification.` 인지 본다. job 은 Store 가 제출을 받아들일 때까지 (`msstore submission poll`) 기다리므로, 이 줄이 나왔으면 제출이 인증으로 넘어간 것이다. Partner Center → 앱 → 제출 상태에서도 볼 수 있다. 패키지 버전은 `X.Y.Z.0` 이다 — 네 번째 자리는 Store 가 쓰므로 항상 0 이고, 버전은 Store 에 이미 있는 것보다 높아야 한다.

14. **인증 확인**
    인증은 보통 영업일 3일 안에 끝난다. 떨어지면 Partner Center 의 인증 보고서에 이유가 나온다. 통과하면 Store 에 게시되고, Store 가 설치본을 업데이트한다 (Store 앱 → 라이브러리 → **업데이트 받기** 로 바로 받을 수 있다).

15. **`submit-store` 가 실패했을 때**
    - 제출하기 전에 실패했으면 (문구 · 자격 증명 · 업로드) 원인을 고친 뒤 그 job 만 다시 실행한다. 다시 실행하면 만들다 만 제출을 지우고 처음부터 한다. 이미 제출된 뒤에는 다시 실행하지 않는다 — 인증 중인 제출을 갈아치운다.
    - Store 가 제출을 거부했으면 (`poll` 이 `CommitFailed` 로 끝남) 로그의 오류나 Partner Center 의 제출 화면에서 이유를 보고 고친다. 패키지 버전이 Store 에 있는 것보다 높지 않을 때가 흔하다. 거부된 제출은 인증에 들어가지 않았으므로 다시 실행해도 된다 — 다시 실행하면 그 제출을 지우고 새로 만든다.
    - 워크플로를 고쳐야 하면, 아티팩트의 AppX 를 받아 로컬 CLI 로 같은 스크립트를 돌린다. `--dry-run` 은 아무것도 바꾸지 않고 넣을 문구만 보여 주고, `--no-commit` 은 제출 직전에서 멈춘다.
      ```bash
      gh run download <run-id> -n msstore-appx-vX.Y.Z -D store-package
      MSSTORE=<msstore.exe 경로> bun run scripts/store-submit.ts --package-dir store-package
      ```
    - 그것도 안 되면 Partner Center → 앱 → **업데이트** 에서 손으로 낸다. 패키지를 받은 `.appx` 로 바꾸고 (이전 버전 패키지는 뺀다), 한국어 · 영어의 **새 기능** 을 바꾼다. 칸마다 넣을 값은 [`STORE.md`](STORE.md) 에 있다.

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
