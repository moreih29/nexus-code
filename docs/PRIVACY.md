# NexusCode 개인정보처리방침

[English](#nexuscode-privacy-policy)

시행일: 2026년 11월 14일

NexusCode는 사용 통계, 분석, 오류 보고를 개발자에게 보내지 않습니다. 앱은 로그인하지 않고도 쓸 수 있고, 그때는 **설정 → 원격**에서 로그인 방법 목록을 불러올 때 말고는 개발자가 운영하는 서버와 통신하지 않습니다. 이 요청에는 계정이나 기기에 관한 정보가 들어 있지 않습니다. NexusCode 계정으로 로그인해 원격, 음성 입력, 노트 녹음, 모바일 앱을 쓸 때만 아래 [NexusCode 계정](#nexuscode-계정)에 적은 정보가 개발자가 운영하는 서버(이하 "서버")를 거칩니다.

## 기기에 저장하는 정보

설정, 워크스페이스 목록, 열린 탭 같은 앱 상태와 노트(글, 파일, 그림, 녹음)는 이 기기의 앱 데이터 폴더와 사용자 홈의 `.nexus-code` 폴더에만 저장합니다. 로그인 토큰과 계정 키는 운영체제의 키 저장소(macOS 키체인, Windows 데이터 보호 API, Linux 키링)로 암호화해 이 기기의 앱 데이터 폴더에만 저장합니다. Linux에서 키링을 쓸 수 없으면 저장하지 않고, 앱을 끌 때까지만 기억합니다. Microsoft Store에서 설치한 앱은 제거할 때 앱 데이터 폴더도 함께 지워집니다.

## 사용자가 요청할 때만 하는 통신

- **SSH 워크스페이스**: 사용자가 지정한 호스트에 접속하고, 원격 작업에 필요한 NexusCode 에이전트를 그 호스트의 사용자 홈(`~/.nexus-code`)에 올립니다. 비밀번호와 키 암호는 접속할 때만 쓰고 저장하지 않습니다.
- **Git**: 가져오기, 푸시 같은 작업을 할 때 사용자가 설정한 원격 저장소와 통신합니다. 인증은 Git(과 Git Credential Manager)이 처리합니다.
- **브라우저 탭**: 사용자가 연 웹 페이지를 불러옵니다. 주소창에 URL이 아닌 검색어를 넣으면 Google 검색으로 보냅니다.
- **링크**: 링크와 "Git 다운로드" 같은 버튼은 기본 브라우저로 엽니다.

## NexusCode 계정

로그인해서 계정 기능을 쓸 때 서버가 처리하는 정보입니다.

- **로그인**: Google 또는 GitHub로 로그인하면 이메일 주소, 이름, 그 서비스의 계정 식별자를 받아 계정을 만들고, 계정을 지울 때까지 보관합니다.
- **기기**: 로그인한 기기마다 기기 이름(컴퓨터나 휴대폰의 이름), 운영체제, 로그인한 시각, 마지막으로 접속한 시각(1시간 단위)을 보관합니다. 로그인은 30일 동안 쓰지 않으면 끝나고, 그 기기의 정보도 지웁니다. 서버에는 로그인 토큰을 해시로만 저장합니다.
- **계정 비밀번호와 종단간 암호화**: 계정 비밀번호는 서버로 보내지 않습니다. 기기들이 함께 쓰는 계정 키는 기기에서 계정 비밀번호로 잠근 뒤 서버에 맡기며, 서버는 이를 열 수 없습니다.
- **원격**: 기기 사이에 오가는 내용(에이전트 세션, 터미널 화면, 파일, 사진)은 종단간 암호화되어 서버를 거쳐 전달됩니다. 서버는 어느 기기에서 어느 기기로 가는지와 크기, 시각만 알 수 있고, 내용을 열거나 저장하지 않습니다.
- **음성 입력**: 말하는 동안 소리를 서버를 거쳐 음성 인식 서비스 Soniox로 보내 실시간으로 받아씁니다. 서버는 소리와 받아쓴 글을 저장하지 않고, 쓴 시간만 기록합니다.
- **노트 녹음**: 녹음하는 동안의 소리는 음성 입력처럼 Soniox로 보내 실시간으로 받아쓰고, 목소리를 구별해 말한 사람별로 나눕니다(누구인지 알아내지는 않습니다). 녹음이 끝난 뒤 더 정확한 글을 얻으려고 녹음 파일을 서버를 거쳐 Soniox로 한 번 더 보낼 수 있습니다. 이 파일은 받아쓴 글이 나오면 바로 지우고, 글은 앱이 가져가면 지우며, 늦어도 파일을 보내고 하루 안에 모두 지웁니다. 서버는 그동안 녹음 길이와 처리 상태만 보관합니다.
- **사용량**: 음성 입력과 노트 녹음에 쓴 시간을 달마다 기록합니다.
- **모바일 앱**: 사용자가 고른 사진만 읽어서, 종단간 암호화해 컴퓨터로 보냅니다. 카메라와 마이크는 쓰지 않습니다.
- **운영 기록**: 서버는 Cloudflare에서 돌아갑니다. 요청을 처리한 기록(시각, 경로, 결과, IP 주소 같은 접속 정보)은 오류를 찾고 남용을 막는 데만 쓰며 Cloudflare에 며칠 동안 남습니다. 로그인 시도가 지나치게 많은 곳을 막으려고 접속한 네트워크를 잠시 셉니다.

Soniox는 받은 소리와 글을 모델 학습에 쓰지 않습니다.

### 계정 삭제

앱의 **설정 → 원격**에서 계정을 지우면 위 정보를 바로 지우고, Soniox에 남은 노트 녹음과 글은 한 시간 안에 지웁니다. 다만 계정을 지웠다 다시 만들어 사용 한도를 되돌리지 못하도록, 그달에 쓴 시간만 로그인 계정 식별자의 해시와 함께 그달 말까지 남깁니다.

### 처리를 맡기는 곳과 국외 이전

계정 기능을 쓰는 동안 아래 회사가 정보를 처리하며, 이들의 서버는 대한민국 밖에 있습니다. 정보는 해당 기능을 쓸 때 네트워크로 전송됩니다. 로그인하지 않거나 해당 기능을 쓰지 않으면 보내지 않습니다.

| 받는 곳 | 하는 일 | 위치 | 받는 정보 | 보관 기간 |
|---|---|---|---|---|
| Cloudflare, Inc. | 서버와 데이터베이스 운영 | 미국 등 Cloudflare의 데이터 센터 | 위 계정 정보, 원격의 암호화된 내용(전달만) | 계정을 지울 때까지 |
| Soniox | 음성 인식 | 미국 | 음성 입력과 노트 녹음의 소리, 노트 녹음 파일 | 실시간은 받아쓰는 동안, 녹음 파일과 그 글은 최대 하루 |
| Google, GitHub | 로그인 | 미국 | 사용자가 그 서비스에서 직접 로그인합니다 | 각 서비스의 방침에 따름 |

## 업데이트 확인

Microsoft Store에서 설치한 앱은 Store가 업데이트하며, 앱이 따로 새 버전을 확인하지 않습니다. macOS와 Linux 빌드는 앱을 켤 때와 켜져 있는 동안 4시간마다 GitHub Releases(github.com)에서 새 버전 정보를 받아 옵니다. 이때 GitHub은 일반 웹 요청처럼 IP 주소 같은 접속 정보를 볼 수 있습니다. **설정 → 정보** 에서 자동 확인을 끌 수 있습니다. 릴리스 노트를 열 때도 같은 곳에서 최근 릴리스 목록을 받아 옵니다.

## 다른 서비스

Microsoft Store, Apple App Store, Cloudflare, Soniox, GitHub, Google, 그리고 사용자가 접속하는 호스트와 웹 사이트는 각자의 개인정보처리방침을 따릅니다.

## 문의

<https://github.com/moreih29/nexus-code/issues>

## 변경

이 방침이 바뀌면 이 문서를 고치고 시행일을 갱신합니다.

---

# NexusCode Privacy Policy

Effective November 14, 2026

NexusCode sends no usage statistics, analytics or error reports to its developer. The app works without signing in, and then it does not talk to any server the developer runs, except to list the ways to sign in when you open **Settings → Remote**; that request carries nothing about you or your device. Only when you sign in to a NexusCode account to use remote, voice input, note recording or the mobile app does the information under [NexusCode account](#nexuscode-account) go through the developer's server (the "server").

## What stays on your device

App state such as settings, the workspace list and open tabs, and your notes (text, files, drawings and recordings), are stored only in the app's data folder on this device and in the `.nexus-code` folder in your home folder. Your sign-in token and account key are encrypted with your operating system's key store (the macOS Keychain, the Windows Data Protection API, a Linux keyring) and stored only in the app's data folder on this device. On Linux without a keyring they are not stored, and are remembered only until the app quits. When you uninstall the app installed from the Microsoft Store, its data folder is removed with it.

## Connections made only when you ask

- **SSH workspaces**: the app connects to the hosts you name and copies the NexusCode agent that remote work needs to your home folder there (`~/.nexus-code`). Passwords and key passphrases are used to connect and are not stored.
- **Git**: fetching, pushing and similar operations talk to the remotes you configured. Git (and Git Credential Manager) handles the sign-in.
- **Browser tab**: the app loads the web pages you open. A search term typed in the address bar, rather than a URL, goes to Google Search.
- **Links**: links and buttons such as "Download Git" open in your default browser.

## NexusCode account

What the server handles when you sign in and use account features.

- **Sign-in**: signing in with Google or GitHub gives the server your email address, your name and your account's identifier at that service. They make your account and are kept until you delete it.
- **Devices**: for each device signed in, the server keeps its name (your computer's or phone's), its operating system, when it signed in and when it was last seen (to the hour). A sign-in not used for 30 days ends, and the device's details go with it. Sign-in tokens are stored only as hashes.
- **Account password and end-to-end encryption**: your account password is never sent to the server. The account key your devices share is locked with it on your device before the server keeps it, and the server cannot open it.
- **Remote**: what passes between your devices (agent sessions, terminal screens, files, photos) is end-to-end encrypted and relayed by the server. The server can tell only which device it goes from and to, its size and its time; it cannot read it and does not store it.
- **Voice input**: while you speak, the sound goes through the server to the speech-to-text service Soniox, which transcribes it as you speak. The server stores neither the sound nor the text, only how long you used it.
- **Note recording**: while you record, the sound goes to Soniox and is transcribed as voice input is, with voices told apart so the text is split by speaker (it does not identify anyone). After the recording, its file may go once more through the server to Soniox for a more accurate text. The file is deleted as soon as its text is ready, the text once the app has it, and both within a day of the file being sent at the latest. Until then the server keeps only the recording's length and how far its transcription is.
- **Usage**: the time you used voice input and note recording is recorded each month.
- **Mobile app**: it reads only the photos you choose, and sends them end-to-end encrypted to your computers. It does not use the camera or the microphone.
- **Operational logs**: the server runs on Cloudflare. Records of the requests it handles (time, path, result and connection details such as your IP address) are used only to find faults and stop abuse, and stay with Cloudflare for a few days. To stop excessive sign-in attempts, the server briefly counts requests from each network.

Soniox does not use the sound or text it receives to train its models.

### Deleting your account

Deleting your account in the app (**Settings → Remote**) deletes the information above at once, and note recordings and text left at Soniox within an hour. So that deleting and re-creating an account cannot reset the usage allowance, only the time used that month stays, with a hash of your sign-in's identifier, until the month ends.

### Processors and transfers abroad

While you use account features, the companies below process your information on servers outside the Republic of Korea. It is sent over the network when you use the feature concerned; nothing is sent if you do not sign in or do not use it.

| Recipient | Role | Location | What it receives | Kept for |
|---|---|---|---|---|
| Cloudflare, Inc. | Runs the server and its database | Cloudflare data centers, including in the US | The account information above, and remote's encrypted content (relayed only) | Until you delete your account |
| Soniox | Speech-to-text | United States | The sound of voice input and note recording, and note recordings' files | Live: while transcribing; files and their text: a day at most |
| Google, GitHub | Sign-in | United States | You sign in at their service directly | As their policies say |

## Update checks

The Microsoft Store updates the app installed from it; that app does not check for new versions itself. The macOS and Linux builds read new version information from GitHub Releases (github.com) when the app starts and every 4 hours while it runs; as with any web request, GitHub can see connection details such as your IP address. You can turn automatic checks off in **Settings → About**. Opening the release notes reads the recent releases from the same place.

## Other services

The Microsoft Store, the Apple App Store, Cloudflare, Soniox, GitHub, Google, and the hosts and websites you connect to follow their own privacy policies.

## Contact

<https://github.com/moreih29/nexus-code/issues>

## Changes

If this policy changes, this document is updated along with its effective date.
