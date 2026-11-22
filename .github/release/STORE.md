# Microsoft Store 등록 정보

Partner Center 제출 화면의 각 칸에 넣을 값을 모은 문서다. 제출 순서는 [RELEASING.md](RELEASING.md#5-microsoft-store-제출) 를 따른다. 버전마다 바뀌는 칸은 **새 기능** 하나뿐이다.

## 제품 ID

Partner Center → 제품 관리 → 제품 ID 의 값이 `electron-builder.yml` 의 `appx` 와 같아야 패키지가 올라간다.

| Partner Center | 값 |
|---|---|
| Package/Identity/Name | `moreih29.NexusCode` |
| Package/Identity/Publisher | `CN=787B1269-D052-4086-B365-5CF6F74571BE` |
| Package/Properties/PublisherDisplayName | `moreih29` |

## 가격 및 사용 가능 여부

- 가격: 무료
- 시장: 모든 시장
- 표시 여부: 공개 (Store 에서 검색 가능)

## 속성

| 칸 | 값 |
|---|---|
| 범주 | 개발자 도구 |
| 개인정보처리방침 URL | `https://github.com/moreih29/nexus-code/blob/main/docs/PRIVACY.md` |
| 웹 사이트 | `https://github.com/moreih29/nexus-code` |
| 지원 연락처 | `https://github.com/moreih29/nexus-code/issues` |
| 시스템 요구 사항 (하드웨어) | 최소: 키보드, 마우스 |
| 추가 시스템 요구 사항 | 최소: `Git for Windows (source control)` |
| 제품 선언 | 기본값 그대로 |

Windows 버전과 아키텍처는 패키지가 정한다: Windows 11 이상 (`appx.minVersion`), x64. ARM PC 는 x64 에뮬레이션으로 실행한다.

## 연령 등급 (IARC 설문)

게시자가 직접 답한다. 사실에 맞게 답할 때 걸리는 항목:

- 앱 종류: 게임이 아닌 앱 (유틸리티/생산성)
- 폭력, 성적 콘텐츠, 도박, 약물 등: 모두 아니오
- 사용자 간 소통·콘텐츠 공유 기능: 아니오
- 위치 공유: 아니오
- 디지털 상품 구매: 아니오
- **제한 없는 인터넷 접근: 예** — 브라우저 탭 주소창에 아무 URL 이나 넣을 수 있다.

## 제출 옵션

### 제한된 기능 (`runFullTrust`) 사유

인증 담당자가 읽으므로 영어로 쓴다.

```
NexusCode is a desktop code editor built with Electron and packaged as MSIX
(a full-trust Win32 app). runFullTrust is what its core features need: the
integrated terminal starts the user's shells (PowerShell, cmd) in a Windows
pseudoconsole, source control runs the user's Git for Windows, and a bundled
helper process (the NexusCode agent) watches and searches the workspace
folders. None of these can run in an AppContainer.
```

### 인증 담당자 메모

```
NexusCode is a code editor for developers. It needs no account or sign-in.

To try it: click "Add workspace" and pick any folder. The folder opens with
its file tree, an editor and a terminal tab (PowerShell).

Source control needs Git for Windows (https://git-scm.com/downloads/win).
Without Git, the Source Control view says Git is not installed and links to
that download; the rest of the app works. SSH workspaces need an SSH host
the tester can reach and are optional.

The UI follows the Windows display language (Korean or English) and can be
changed in Settings > Appearance.
```

## 스토어 등록 정보

한국어(ko-KR)와 영어(en-US) 둘 다 만든다. 패키지가 두 언어를 선언하므로 Partner Center 가 둘 다 요구한다.

**설명 첫 줄의 Git 안내는 지우지 않는다.** 다른 소프트웨어가 필요한 앱은 설명 첫머리에 밝혀야 한다 (Microsoft Store 정책 10.2.4).

### 스크린샷

PNG, 1366×768 이상, 최대 10 장. 한국어 등록 정보에는 한국어 UI, 영어 등록 정보에는 영어 UI 화면을 올린다. 첫 장이 Store 목록에 대표로 보이므로, 워크스페이스 여러 개 · 파일 트리 · 에디터 · 터미널이 한 화면에 보이는 장면을 첫 장으로 한다.

### ko-KR

**설명**

```
※ 소스 제어(Git) 기능을 쓰려면 Git for Windows가 필요합니다. 설치되어 있지 않으면 앱이 설치 방법을 안내합니다.

NexusCode는 한 창에서 여러 워크스페이스를 다루는 코드 에디터입니다. 프로젝트마다 창을 따로 띄울 필요 없이, 워크스페이스마다 자기만의 파일 트리, 에디터 탭, 터미널을 두고 단축키 하나로 오갈 수 있습니다. 로컬 폴더와 SSH 원격 호스트의 폴더를 같은 방식으로 다룹니다.

VS Code와 같은 Monaco 에디터와 통합 터미널을 한 화면에 담았고, 단축키도 VS Code와 같습니다.
```

**새 기능** (버전마다 바꾼다)

```
Windows용 첫 버전입니다.
```

**제품 기능** (한 줄에 하나씩, 최대 20개)

```
한 창에서 여러 워크스페이스를 열고 단축키로 전환
워크스페이스마다 독립된 파일 트리, 에디터 탭, 터미널
VS Code와 같은 Monaco 에디터, 좌우·상하 분할 에디터 그룹
통합 터미널 (PowerShell, 명령 프롬프트)
SSH 원격 호스트의 폴더를 로컬처럼 편집
소스 제어: 변경 사항, 스테이징, 커밋, 브랜치, 푸시·풀, 기록
브라우저 탭과 Markdown 미리보기
VS Code 호환 단축키
한국어·영어 UI
```

**검색어** (최대 7개)

```
code editor, 코드 에디터, ssh, terminal, git, monaco, workspace
```

**저작권 및 상표 정보**

```
© 2026 moreih29. MIT License.
```

### en-US

**Description**

```
Note: source control (Git) needs Git for Windows. When it is missing, the app shows how to install it.

NexusCode is a code editor that holds many workspaces in one window. Instead of one window per project, each workspace keeps its own file tree, editor tabs and terminals, and one shortcut switches between them. Local folders and folders on SSH hosts work the same way.

It puts the Monaco editor, the editor of VS Code, and an integrated terminal on one screen, with VS Code's keyboard shortcuts.
```

**What's new in this version** (changes with each version)

```
The first version for Windows.
```

**Product features** (one per line, up to 20)

```
Many workspaces in one window, switched with a shortcut
Each workspace keeps its own file tree, editor tabs and terminals
The Monaco editor of VS Code, with side-by-side and stacked editor groups
Integrated terminal (PowerShell, Command Prompt)
Edit folders on SSH hosts as if they were local
Source control: changes, staging, commits, branches, push and pull, history
Browser tabs and Markdown preview
VS Code keyboard shortcuts
English and Korean UI
```

**Search terms** (up to 7)

```
code editor, ssh, terminal, git, monaco, workspace, ide
```

**Copyright and trademark info**

```
© 2026 moreih29. MIT License.
```
