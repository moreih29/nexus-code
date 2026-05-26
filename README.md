# NexusCode

macOS 용 멀티 워크스페이스 VSCode-style 에디터 — Monaco 에디터 + 터미널을 한 창에 담은 형태.

## 요구사항

- macOS 14 (Sonoma) 이상
- Apple Silicon (M1 / M2 / M3 / M4)

> 현재 배포는 Apple Silicon (arm64) 빌드만 제공합니다. Intel (x64) 머신은 소스 빌드로 사용 가능 — [docs/INSTALL.md#self-build](docs/INSTALL.md#self-build) 참고.

## 설치

[Releases 페이지](https://github.com/moreih29/nexus-code/releases)에서 최신 dmg 를 내려받습니다.

| Mac | 파일 |
|---|---|
| Apple Silicon | `NexusCode-X.Y.Z-arm64.dmg` |

`.dmg` 를 마운트하고 **NexusCode** 를 `/Applications` 로 드래그한 뒤, 아래 **보안 해제** 단계를 따라야 첫 실행이 가능합니다.

## 보안 해제 (Gatekeeper 우회)

NexusCode 는 Apple 코드 사이닝 / 공증(notarization) 없이 배포됩니다. 첫 실행 시 macOS Gatekeeper 가 앱을 차단하거나 "손상된 앱" 으로 표시합니다 — 정상적인 동작입니다.

### 가장 빠른 방법 — 터미널 한 줄 (모든 macOS 권장)

```bash
xattr -dr com.apple.quarantine "/Applications/NexusCode.app"
```

quarantine 속성을 제거하면 이후 더블클릭으로 바로 열립니다.

### GUI 방식

**macOS 14 (Sonoma)**

1. Finder 에서 `/Applications/NexusCode.app` 을 우클릭 (또는 Control+클릭)
2. **열기** 선택
3. "이 앱을 열 수 없습니다" 다이얼로그에서 **열기** 클릭

**macOS 15 (Sequoia) 이상**

1. 앱을 더블클릭 → 차단 알림 확인
2. **시스템 설정 → 개인정보 보호 및 보안** 으로 이동
3. 하단 "NexusCode 차단됨" 항목 옆 **그래도 열기** 클릭
4. 확인 다이얼로그에서 **열기**

자세한 단계는 [docs/INSTALL.md#3-gatekeeper-우회](docs/INSTALL.md) 참고.

## 키보드 단축키

VSCode 호환 매핑. `CmdOrCtrl` 은 OS 에 맞게 자동 매핑되며 (macOS = ⌘, Win/Linux = Ctrl), 아래 표는 macOS 표기 기준입니다.

### 파일 · 편집

| 동작 | 단축키 |
|---|---|
| 새 파일 | ⌘N |
| 파일 열기 | ⌘O · ⌘E |
| 저장 | ⌘S |
| 파일 트리 새로고침 | ⌘R · ⌘⇧R |
| 트리 항목을 사이드로 열기 | ⌘↵ <sub>(파일 트리 포커스 시)</sub> |

### 탭

| 동작 | 단축키 |
|---|---|
| 탭 닫기 | ⌘W |
| 다른 탭 닫기 | ⌘⌥T |
| 저장 안 된 탭 닫기 | ⌘K U |
| 모든 탭 닫기 | ⌘K ⌘W |
| 탭 핀 토글 | ⌘K ⌘⇧↵ |
| 이전 / 다음 탭 | ⌘⌃← · ⌘⌃→ |

### 그룹 (패널 분할)

| 동작 | 단축키 |
|---|---|
| 우측으로 분할 | ⌘\ |
| 아래로 분할 | ⌘⇧\ |
| 그룹 닫기 | ⌘⇧W |
| 좌 / 우 / 상 / 하 그룹 포커스 | ⌘⌥← · ⌘⌥→ · ⌘⌥↑ · ⌘⌥↓ |

### 워크스페이스

| 동작 | 단축키 |
|---|---|
| 심볼 검색 | ⌘⇧O |
| 이전 / 다음 워크스페이스 | ⌘⌃↑ · ⌘⌃↓ |
| 워크스페이스 추가 | ⌘⇧N |

### 작업 영역

| 동작 | 단축키 |
|---|---|
| 설정 열기 | ⌘, |
| Files 패널 토글 | ⌘B |
| Sidebar 토글 | ⌘⇧B |

### 터미널

| 동작 | 단축키 |
|---|---|
| 새 터미널 | ⌘T |
| 멀티라인 입력 | Shift+Enter |

### 경로

| 동작 | 단축키 |
|---|---|
| Finder 에서 열기 | ⌘⌥R |
| 절대 경로 복사 | ⌘⌥C |
| 상대 경로 복사 | ⌘⇧⌥C |

> ⌘ 단독 단축키만 앱이 가로채며, ⌃ 단독(⌘ 안 누름) 은 터미널로 그대로 전달됩니다 — 즉 xterm 의 `Ctrl+R` (reverse-i-search), `Ctrl+W` (delete-word), `Ctrl+T` (transpose) 같은 셸 단축키가 정상 동작합니다.

## 채널

| 채널 | 설명 |
|---|---|
| **Stable** | 권장. 정식 릴리스만 수신. |
| **Beta** | 옵트인. 프리릴리스 포함. 일부 거친 부분이 있을 수 있음. |

**설정 → Updates → Update Channel** 에서 전환합니다.

## 자체 빌드 / 개발

빌드 요구사항, 명령 시퀀스, 산출물 위치는 [docs/INSTALL.md#self-build](docs/INSTALL.md) 에 정리되어 있습니다.

## 라이선스

TBD
