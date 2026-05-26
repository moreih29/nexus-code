# NexusCode — Installation Guide

## Prebuilt DMG 설치

### 1. 다운로드

[Releases 페이지](https://github.com/moreih29/nexus-code/releases)에서 Mac 아키텍처에 맞는 파일을 내려받는다.

| Mac 종류 | 파일명 |
|---|---|
| Apple Silicon (M1/M2/M3/M4) | `NexusCode-X.Y.Z-arm64.dmg` |

> Intel (x64) 빌드는 정식 배포에 포함되지 않는다. Intel 머신 사용자는 [Self-build](#self-build) 절차로 직접 빌드한다.

### 2. 설치

`.dmg`를 마운트하고 **NexusCode**를 `/Applications`로 드래그한다.

### 3. Gatekeeper 우회

NexusCode는 현재 Apple 공증(notarization) 없이 배포된다. 처음 실행 시 macOS Gatekeeper가 앱을 차단할 수 있다.

#### macOS 14 (Sonoma)

1. Finder에서 `/Applications/NexusCode.app`을 우클릭(또는 Control+클릭)한다.
2. 메뉴에서 **Open**을 선택한다.
3. "이 앱을 열 수 없습니다" 다이얼로그에서 **Open** 버튼을 클릭한다.

이후 실행부터는 일반 더블클릭으로 열린다.

#### macOS 15+ (Sequoia 이상)

1. 앱을 더블클릭하면 차단 메시지가 표시된다.
2. **System Settings → Privacy & Security**로 이동한다.
3. 하단 "NexusCode was blocked…" 항목 옆 **Open Anyway** 버튼을 클릭한다.
4. 확인 다이얼로그에서 **Open**을 클릭한다.

#### 터미널 방식 (모든 macOS 권장)

모든 macOS 버전에서 아래 명령 하나로 quarantine 속성을 제거할 수 있다.

```bash
xattr -dr com.apple.quarantine "/Applications/NexusCode.app"
```

이후 일반 더블클릭으로 앱이 열린다.

---

## Self-build

### Prerequisites

| 도구 | 버전 |
|---|---|
| macOS | 14 이상 |
| Bun | 1.x 이상 |
| Node.js | 20.x |
| Go | 1.22 이상 |
| Xcode Command Line Tools | 최신 (`xcode-select --install`) |

### 빌드 명령 시퀀스

```bash
# 저장소 클론
git clone https://github.com/moreih29/nexus-code.git
cd nexus-code

# 의존성 설치 (postinstall에서 node-pty, better-sqlite3 native rebuild 포함)
bun install

# 현재 아키텍처용 DMG 패키징
bun run package:mac:current
```

`package:mac` 은 DMG + ZIP (auto-updater 용) 까지 함께 만든다 — 기본은 arm64. Intel x64 머신이거나 cross-build 가 필요하면 다음과 같이 직접 호출한다.

```bash
bun run scripts/build-agent.ts && bun run build
bun x electron-builder --mac dmg --x64 --publish never
```

> 단일 머신에서 `--arm64 --x64` 를 함께 빌드하면 node-pty / better-sqlite3 의 native rebuild 가 한쪽 아키텍처만 정확히 잡힌다 — Cross-arch 빌드는 GitHub Actions 의 매트릭스 같은 별도 native 러너 분리 환경에서만 안전하다.

### 산출물 위치

```
dist/
  NexusCode-X.Y.Z-arm64.dmg
  NexusCode-X.Y.Z-arm64.zip
```

### Self-built 앱 실행

로컬에서 직접 빌드한 `.app`은 ad-hoc 서명이 적용되며 quarantine 속성이 없다.
별도 우회 절차 없이 더블클릭으로 바로 열린다.

---

## 채널 (Stable / Beta)

| 채널 | 설명 |
|---|---|
| **Stable** | 기본값. 정식 릴리스만 수신. |
| **Beta** | 선택 사항. 프리릴리스 빌드를 포함. 불안정할 수 있음. |

채널 전환: **Settings → Updates → Update Channel** SegmentedControl에서 변경한다.

Beta 채널 빌드는 SSH 원격 호스트에 `~/.nexus-code-beta/` 아래에 에이전트·런타임·LSP 번들을 설치하며, Stable 채널(`~/.nexus-code/`)과 디렉터리가 분리된다 — 한 원격을 두 채널이 공유해도 충돌하지 않는다. 빌드 시점에 `NEXUS_CHANNEL=beta` 환경변수로 결정된다.
디버깅 시 `NEXUS_REMOTE_AGENT_ROOT` 환경변수로 원격 설치 경로를 직접 지정할 수도 있다 (escape hatch).

---

## 문제 해결

### "App is damaged and can't be opened"

quarantine 속성이 남아 있는 경우다. 터미널에서 아래 명령을 실행한다.

```bash
xattr -dr com.apple.quarantine "/Applications/NexusCode.app"
```

### Native module 오류 (node-pty, better-sqlite3)

아키텍처 불일치 또는 rebuild 누락이 원인일 수 있다. 아래 명령으로 재빌드한다.

```bash
bun run postinstall
```
