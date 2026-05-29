# NexusCode — Release Guide

## Release Notes 체크리스트

릴리스 노트는 GitHub Release body에 직접 작성한다. 아래 카테고리를 기준으로 항목을 분류한다.

### Added
사용자가 새롭게 사용할 수 있는 기능을 기술한다.
- 신규 UI 컴포넌트, 명령, 설정 항목 등.

### Changed
기존 동작이 변경된 항목을 기술한다.
- 기본값 변경, 레이아웃/UX 재설계, 명령어·키 바인딩 변경 등.

### Fixed
버그 수정 항목을 기술한다.
- 재현 조건과 수정 결과를 함께 적으면 유용하다.

### Protocol & Remote 영향

아래 항목 중 해당하는 것이 있으면 반드시 명시한다.

- **Agent protocol version**: `src/main/features/` 또는 Go 에이전트의 프로토콜 버전이 바뀐 경우.
- **NEXUS_REMOTE_AGENT_ROOT 변경**: escape hatch 경로 로직이 바뀐 경우.
- **첫 SSH 부팅 재업로드 필요**: 원격 에이전트 바이너리가 업데이트되어 기존 SSH 워크스페이스에서 재업로드가 필요한 경우.
- **prune / 캐시 정책 변경**: `~/.nexus-code/` 또는 `~/.nexus-code-beta/` 내 파일 구조가 변경된 경우.

---

## Release 절차

### 사전 조건

- `main` 브랜치의 CI (`ci.yml`) 가 green 상태여야 한다.

### 8단계 절차

1. **CI green 확인**
   GitHub Actions → CI 탭에서 `main` 최신 커밋의 CI 워크플로가 모두 통과했는지 확인한다.

2. **Version bump**
   `package.json`의 `version` 필드를 SemVer에 맞게 올린다. 커밋 메시지 예시:
   ```
   chore: bump version to 0.2.0
   ```

3. **Draft a new release**
   GitHub 저장소 → **Releases** → **Draft a new release** 클릭.

4. **Tag 및 Release body 작성**
   - Tag: `v0.2.0` 형식 (package.json `version`과 일치).
   - Title: `v0.2.0` 또는 `v0.2.0 — <한 줄 요약>`.
   - Body: 위 체크리스트 카테고리 순서로 릴리스 노트 작성.

5. **Pre-release 토글**
   - 베타 빌드인 경우 **Set as a pre-release** 체크박스를 활성화한다.
   - 정식 릴리스라면 체크 해제 상태로 둔다.
   - 이 설정이 `NEXUS_CHANNEL` (`stable` / `beta`)과 업데이트 수신 대상을 결정한다.

6. **Publish release**
   **Publish release** 버튼을 클릭한다.

7. **release.yml 자동 트리거 대기**
   Release가 published 되면 `release.yml` 워크플로가 자동으로 실행된다.
   - `build-agent` job: ubuntu-latest에서 Go 에이전트 크로스컴파일 + Node runtime + LSP 번들 산출.
   - `package` job: `macos-14` (Apple Silicon arm64) 에서 native rebuild 후 electron-builder로 DMG / ZIP 패키징 및 Release asset 업로드. **arm64 단일 빌드만 제공한다** — Intel(x64) 정식 배포는 하지 않으며, Intel 사용자는 [`INSTALL.md`](INSTALL.md#self-build)의 self-build 절차를 따른다.

8. **동작 확인**
   - GitHub Release에 아래 파일이 모두 첨부되었는지 확인한다:
     ```
     NexusCode-X.Y.Z-arm64.dmg
     NexusCode-X.Y.Z-arm64.zip
     latest-mac.yml
     ```
   - arm64 DMG를 설치하여 앱 버전 및 업데이트 채널이 올바른지 확인한다.

---

## 미래 작업 — Apple 서명 전환

현재 빌드는 `identity: null` / `notarize: false` (ad-hoc 서명 + 공증 없음)로 배포된다.
사용자 베이스가 늘거나 Gatekeeper 우회 안내가 운영 부담이 될 때 Apple Developer 서명 + 공증으로 전환한다.

전환 절차 및 필요한 `electron-builder.yml` / GH Actions secrets / entitlements 변경 사항은
[`.nexus/memory/external-future-signing-migration.md`](../.nexus/memory/external-future-signing-migration.md)를 참조한다.
