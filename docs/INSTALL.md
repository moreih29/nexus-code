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

보안 해제는 처음 설치할 때 한 번만 한다. 이후 버전은 앱 안에서 업데이트하며(아래 [업데이트](#업데이트)), 앱이 직접 받은 업데이트에는 quarantine 속성이 붙지 않는다.

---

## Linux 설치

### 1. 다운로드

[Releases 페이지](https://github.com/moreih29/nexus-code/releases)에서 배포판과 아키텍처에 맞는 파일을 내려받는다. Ubuntu 24.04 에서 확인했다.

| 형식 | x64 | arm64 |
|---|---|---|
| deb (Debian · Ubuntu) | `NexusCode-X.Y.Z-amd64.deb` | `NexusCode-X.Y.Z-arm64.deb` |
| AppImage (그 밖의 배포판) | `NexusCode-X.Y.Z-x86_64.AppImage` | `NexusCode-X.Y.Z-arm64.AppImage` |

Debian · Ubuntu 계열이면 deb 를 권장한다.

### 2-a. deb 설치

```bash
sudo apt install ./NexusCode-X.Y.Z-amd64.deb
```

앱은 `/opt/NexusCode` 에 설치되고 애플리케이션 메뉴에 **NexusCode** 가 생긴다. 터미널에서는 `nexus-code` 로 실행한다. 제거는 `sudo apt remove nexus-code`.

### 2-b. AppImage 실행

```bash
chmod +x NexusCode-X.Y.Z-x86_64.AppImage
./NexusCode-X.Y.Z-x86_64.AppImage
```

설치 과정 없이 파일 하나로 실행된다. 앱 안 업데이트가 이 파일을 새 버전으로 바꾸므로, 쓰기 권한이 있는 곳(예: `~/Applications`)에 둔다.

Ubuntu 23.10 이상에서는 처음 실행 전에 AppArmor 프로필을 한 번 등록해야 한다 — [아래](#ubuntu-2310-이상에서-appimage-가-바로-종료될-때) 참고.

---

## 업데이트

새 버전 알림의 **Update** 를 누르면 앱이 새 버전을 내려받고, 준비되면 **Restart Now** 로 설치한다. 누르지 않으면 다음 종료 때 설치된다.

- 릴리스 빌드는 모두 같은 자체 서명 인증서로 서명된다. macOS 업데이터(Squirrel.Mac)는 새 버전의 서명이 실행 중인 앱과 같은 인증서일 때만 설치한다.
- 0.10.0 이전 버전은 앱 안 업데이트를 지원하지 않는다. 그 버전에서는 한 번 `.dmg` 로 설치하고 보안 해제를 거친다.
- Self-build 앱(ad-hoc 서명)은 앱 안에서 업데이트할 수 없다. 업데이트가 실패하면 알림의 **Open Release Page** 로 릴리스 페이지에서 내려받는다.
- Linux 의 AppImage 는 같은 방식으로 앱 안에서 업데이트된다. 내려받은 새 AppImage 가 실행 중인 파일을 바꾼다.
- deb 설치도 앱 안에서 업데이트된다. 새 deb 를 내려받아 두고, **Restart Now**(지금 다시 시작) 를 누르면 관리자 암호를 물은 뒤 `dpkg` 로 설치하고 다시 실행한다. 암호를 물어야 하므로 그냥 종료할 때는 설치하지 않는다.

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

### Linux 에서 빌드

| 도구 | 버전 |
|---|---|
| Bun | 1.x 이상 |
| Node.js · npm | 20.x (에이전트 빌드가 LSP 번들을 npm 으로 설치한다) |
| Go | 1.22 이상 |
| C/C++ 빌드 도구 | Debian · Ubuntu 는 `sudo apt install build-essential python3` |

```bash
bun install
bun run package:linux
```

현재 아키텍처용 AppImage 와 deb 를 만든다.

```
dist/
  NexusCode-X.Y.Z-x86_64.AppImage   (arm64: NexusCode-X.Y.Z-arm64.AppImage)
  NexusCode-X.Y.Z-amd64.deb         (arm64: NexusCode-X.Y.Z-arm64.deb)
```

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

### "업데이트를 설치하지 못했습니다"

알림의 **Open Release Page**(릴리스 페이지 열기) 로 `.dmg`(Linux 는 AppImage 나 deb) 를 내려받아 설치한다. 흔한 원인:

- 앱을 `/Applications` 로 옮기지 않고 `.dmg` 안에서 실행 중이다 (읽기 전용이라 교체할 수 없다).
- `/Applications/NexusCode.app` 에 쓰기 권한이 없다.
- Self-build 앱이다 (위 [업데이트](#업데이트) 참고).
- Linux: AppImage 파일이 있는 폴더에 쓰기 권한이 없다.
- Linux: deb 를 설치할 때 관리자 암호 창을 취소했거나 암호가 틀렸다. 다시 업데이트하면 이미 받은 파일을 그대로 쓴다.
- Linux: 관리자 암호 창을 띄울 polkit 인증 에이전트가 없다 (GNOME · KDE 같은 데스크톱 환경에는 기본으로 있다).

자세한 원인은 로그의 `updates` 항목에 남는다 — macOS `~/Library/Logs/NexusCode/main.log`, Linux `~/.config/NexusCode/logs/main.log`.

### Ubuntu 23.10 이상에서 AppImage 가 바로 종료될 때

터미널에서 실행하면 다음 오류를 내고 종료한다.

```
The SUID sandbox helper binary was found, but is not configured correctly.
```

Ubuntu 23.10 부터 AppArmor 가 일반 프로그램의 user namespace 생성을 막는데(`kernel.apparmor_restrict_unprivileged_userns`), 앱(Chromium)의 샌드박스가 이것을 쓰기 때문이다. deb 는 설치할 때 앱용 AppArmor 프로필을 함께 넣으므로 이 문제가 없다.

AppImage 는 아래 프로필을 한 번 등록하면 샌드박스를 켠 채 실행된다.

```bash
sudo tee /etc/apparmor.d/nexuscode-appimage >/dev/null <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile nexuscode-appimage /tmp/.mount_*/nexus-code flags=(unconfined) {
  userns,
  include if exists <local/nexuscode-appimage>
}
EOF
sudo apparmor_parser -r /etc/apparmor.d/nexuscode-appimage
```

이 프로필은 AppImage 가 풀리는 경로(`/tmp/.mount_*/nexus-code`)의 프로그램에 user namespace 를 허용한다. 같은 머신의 다른 사용자도 이 경로로 같은 허용을 받을 수 있으므로, 여러 사람이 쓰는 머신이면 deb 를 쓴다.

`--no-sandbox` 로 실행해도 열리지만, 내장 브라우저 탭을 포함한 웹 콘텐츠의 샌드박스가 꺼지므로 권장하지 않는다.

### Native module 오류 (node-pty, better-sqlite3)

아키텍처 불일치 또는 rebuild 누락이 원인일 수 있다. 아래 명령으로 재빌드한다.

```bash
bun run postinstall
```
