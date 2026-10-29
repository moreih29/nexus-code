# NexusCode 개인정보처리방침

[English](#nexuscode-privacy-policy)

시행일: 2026년 10월 30일

NexusCode는 사용자의 개인정보를 수집하지 않습니다. 앱에는 사용 통계, 분석, 오류 보고를 개발자에게 보내는 기능이 없고, 개발자가 운영하는 서버도 없습니다.

## 기기에 저장하는 정보

설정, 워크스페이스 목록, 열린 탭 같은 앱 상태는 이 기기의 앱 데이터 폴더와 사용자 홈의 `.nexus-code` 폴더에만 저장합니다. Microsoft Store에서 설치한 앱은 제거할 때 앱 데이터 폴더도 함께 지워집니다.

## 사용자가 요청할 때만 하는 통신

- **SSH 워크스페이스**: 사용자가 지정한 호스트에 접속하고, 원격 작업에 필요한 NexusCode 에이전트를 그 호스트의 사용자 홈(`~/.nexus-code`)에 올립니다. 비밀번호와 키 암호는 접속할 때만 쓰고 저장하지 않습니다.
- **Git**: 가져오기, 푸시 같은 작업을 할 때 사용자가 설정한 원격 저장소와 통신합니다. 인증은 Git(과 Git Credential Manager)이 처리합니다.
- **브라우저 탭**: 사용자가 연 웹 페이지를 불러옵니다. 주소창에 URL이 아닌 검색어를 넣으면 Google 검색으로 보냅니다.
- **링크**: 링크와 "Git 다운로드" 같은 버튼은 기본 브라우저로 엽니다.

## 업데이트 확인

Microsoft Store에서 설치한 앱은 Store가 업데이트하며, 앱이 따로 새 버전을 확인하지 않습니다. macOS와 Linux 빌드는 GitHub Releases(github.com)에서 새 버전 정보를 받아 옵니다. 이때 GitHub은 일반 웹 요청처럼 IP 주소 같은 접속 정보를 볼 수 있습니다.

## 다른 서비스

Microsoft Store, GitHub, Google, 그리고 사용자가 접속하는 호스트와 웹 사이트는 각자의 개인정보처리방침을 따릅니다.

## 문의

<https://github.com/moreih29/nexus-code/issues>

## 변경

이 방침이 바뀌면 이 문서를 고치고 시행일을 갱신합니다.

---

# NexusCode Privacy Policy

Effective October 30, 2026

NexusCode does not collect personal information. The app sends no usage statistics, analytics or error reports to its developer, and the developer runs no server for it.

## What stays on your device

App state such as settings, the workspace list and open tabs is stored only in the app's data folder on this device and in the `.nexus-code` folder in your home folder. When you uninstall the app installed from the Microsoft Store, its data folder is removed with it.

## Connections made only when you ask

- **SSH workspaces**: the app connects to the hosts you name and copies the NexusCode agent that remote work needs to your home folder there (`~/.nexus-code`). Passwords and key passphrases are used to connect and are not stored.
- **Git**: fetching, pushing and similar operations talk to the remotes you configured. Git (and Git Credential Manager) handles the sign-in.
- **Browser tab**: the app loads the web pages you open. A search term typed in the address bar, rather than a URL, goes to Google Search.
- **Links**: links and buttons such as "Download Git" open in your default browser.

## Update checks

The Microsoft Store updates the app installed from it; that app does not check for new versions itself. The macOS and Linux builds read new version information from GitHub Releases (github.com), which, as with any web request, can see connection details such as your IP address.

## Other services

The Microsoft Store, GitHub, Google, and the hosts and websites you connect to follow their own privacy policies.

## Contact

<https://github.com/moreih29/nexus-code/issues>

## Changes

If this policy changes, this document is updated along with its effective date.
