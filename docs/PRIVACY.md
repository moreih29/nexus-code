# NexusCode 개인정보처리방침

[English](#nexuscode-privacy-policy)

시행일: 2026년 11월 24일

NexusCode는 사용 통계와 분석을 개발자에게 보내지 않습니다. 오류 정보는 사용자가 버그 신고를 보낼 때만 보냅니다. 앱은 로그인하지 않고도 쓸 수 있고, 그때는 **설정 → 원격**에서 로그인 방법 목록을 불러올 때 말고는 개발자가 운영하는 서버와 통신하지 않습니다. 이 요청에는 계정이나 기기에 관한 정보가 들어 있지 않습니다. NexusCode 계정으로 로그인해 원격, 음성 입력, 노트 녹음, 모바일 앱, 버그 신고를 쓸 때만 아래 [NexusCode 계정](#nexuscode-계정)에 적은 정보가 개발자가 운영하는 서버(이하 "서버")를 거칩니다.

## 기기에 저장하는 정보

설정, 워크스페이스 목록, 열린 탭 같은 앱 상태와 노트(글, 파일, 그림, 녹음)는 이 기기의 앱 데이터 폴더와 사용자 홈의 `.nexus-code` 폴더에만 저장합니다. 로그인 토큰과 계정 키는 운영체제의 키 저장소(macOS 키체인, Windows 데이터 보호 API, Linux 키링)로 암호화해 이 기기의 앱 데이터 폴더에만 저장합니다. Linux에서 키링을 쓸 수 없으면 저장하지 않고, 앱을 끌 때까지만 기억합니다. Microsoft Store에서 설치한 앱은 제거할 때 앱 데이터 폴더도 함께 지워집니다.

## 사용자가 요청할 때만 하는 통신

- **SSH 워크스페이스**: 사용자가 지정한 호스트에 접속하고, 원격 작업에 필요한 NexusCode 에이전트를 그 호스트의 사용자 홈(`~/.nexus-code`)에 올립니다. 비밀번호와 키 암호는 접속할 때만 쓰고 저장하지 않습니다.
- **Git**: 가져오기, 푸시 같은 작업을 할 때 사용자가 설정한 원격 저장소와 통신합니다. 인증은 Git(과 Git Credential Manager)이 처리합니다.
- **브라우저 탭**: 사용자가 연 웹 페이지를 불러옵니다. 주소창에 URL이 아닌 검색어를 넣으면 Google 검색으로 보냅니다.
- **링크**: 링크와 "Git 다운로드" 같은 버튼은 기본 브라우저로 엽니다.

## NexusCode 계정

로그인해서 계정 기능을 쓸 때 서버가 처리하는 정보입니다.

- **가입 요청**: 처음 로그인하면 계정을 바로 만들지 않고 가입 요청을 남깁니다. 요청에는 로그인한 서비스와 그 서비스의 계정 식별자, 이메일 주소, 제공된 이름, 요청한 시각, 시도한 횟수와 마지막 시각을 보관합니다. 개발자가 승인하면 다음 로그인 때 계정을 만듭니다. 대기 중인 요청은 마지막 시도 후 90일이 지나면 지웁니다. 거절된 요청은 30일 동안 보관하며, 그동안은 다시 요청할 수 없습니다. 승인된 요청은 승인 후 30일 안에 로그인하지 않으면 지우고, 계정을 만들었으면 그 뒤 30일이 지나면 지웁니다.
- **로그인**할 때 Google, GitHub 또는 Apple에서 이메일 주소, 제공된 이름(Apple은 첫 로그인 때), 그 서비스의 계정 식별자를 받아 계정을 만들고, 계정을 지울 때까지 보관합니다. Apple에서 ‘나의 이메일 가리기’를 선택하면 Apple이 발급한 중계 주소를 이메일 주소로 저장합니다. Apple이 보낸 갱신 토큰은 계정을 지울 때 폐기를 요청하려고 보관합니다. 계정의 상태(사용 중 또는 정지), 승인된 시각, 마지막으로 접속한 시각(1시간 단위)도 계정을 지울 때까지 보관합니다.
- **기기**: 로그인한 기기마다 기기 이름(컴퓨터나 휴대폰의 이름), 운영체제, 로그인한 시각, 마지막으로 접속한 시각(1시간 단위)을 보관합니다. 로그인은 30일 동안 쓰지 않거나 로그인한 지 180일이 지나면 끝나고, 그 기기의 정보도 지웁니다. 다만 사용자가 기기에 따로 붙인 이름은 같은 앱으로 다시 로그인할 때 되살리려고, 로그인이 끝난 뒤 180일 동안 남깁니다. 서버에는 로그인 토큰을 해시로만 저장합니다.
- **계정 비밀번호와 종단간 암호화**: 계정 비밀번호는 서버로 보내지 않습니다. 기기들이 함께 쓰는 계정 키는 기기에서 계정 비밀번호로 잠근 뒤 서버에 맡기며, 서버는 이를 열 수 없습니다.
- **원격**: 기기 사이에 오가는 내용(에이전트 세션, 터미널 화면, 파일, 사진)은 종단간 암호화되어 서버를 거쳐 전달됩니다. 서버는 어느 기기에서 어느 기기로 가는지와 크기, 시각만 알 수 있고, 내용을 열거나 저장하지 않습니다.
- **음성 입력**: 말하는 동안 소리를 서버를 거쳐 음성 인식 서비스 Soniox로 보내 실시간으로 받아씁니다. 서버는 소리와 받아쓴 글을 저장하지 않습니다. 음성 입력에 쓴 시간은 기록합니다. 사용자가 등록한 **음성 인식 단어**는 계정을 지울 때까지 서버에 저장합니다. 받아쓸 때 이 단어 목록도 소리와 함께 Soniox에 보냅니다.
- **노트 녹음**: 녹음하는 동안의 소리는 음성 입력처럼 Soniox로 보내 실시간으로 받아쓰고, 목소리를 구별해 말한 사람별로 나눕니다(누구인지 알아내지는 않습니다). 앱도 컴퓨터에서 목소리를 소리로 구별합니다. 줄마다 목소리 특징(성문)을 컴퓨터 안에서 계산하며, 이 값은 컴퓨터 밖으로 나가지 않고 녹음하는 동안 메모리에만 두며 저장하지 않습니다. 녹음이 끝난 뒤 더 정확한 녹취록을 얻으려고 녹음 파일을 서버를 거쳐 Soniox로 한 번 더 보낼 수 있습니다. 이 파일은 녹취록이 나오면 바로 지우고, 녹취록은 앱이 가져가면 지우며, 늦어도 파일을 보내고 하루 안에 모두 지웁니다. 서버는 그동안 녹음 길이와 처리 상태만 보관합니다.
- **사용량**: 음성 입력과 노트 녹음에 쓴 시간을 달마다 기록합니다.
- **버그 신고**: 모바일 앱과 데스크톱 앱의 **설정 → 정보 → 버그 신고**에서 신고를 보내면, 서버는 사용자가 쓴 설명과 앱이 붙인 정보, 신고를 보낸 기기의 플랫폼(`ios`, `darwin` 등)을 계정과 연결해 보관합니다. 로그인한 계정으로만 보낼 수 있습니다. 앱이 붙이는 정보는 앱 버전(휴대폰과 태블릿은 빌드 번호도), 운영체제와 그 버전(컴퓨터는 `macOS-26.1`처럼 운영체제 이름과 버전), 기기 종류(휴대폰, 태블릿, 컴퓨터), 휴대폰과 태블릿의 모델 식별자(예: iPhone16,2, iPad14,1), 컴퓨터의 CPU 종류(예: arm64), 앱이 쓰는 원격 규약의 버전, 앱 언어입니다. 끄지 않았으면 최근 오류 기록도 붙입니다. 오류 기록은 최근 20건까지 영역, 오류 코드, HTTP 상태, 몇 초 전에 생겼는지를 담고, 앱 메모리에만 두며 저장하지 않으므로 앱을 끄면 지워집니다. 오류 코드에는 실패한 요청이나 작업의 종류(메서드 이름 등)가 들어갈 수 있습니다. 데스크톱 앱은 같은 오류가 되풀이되면 한 건으로 묶어 횟수를 붙이고, 오류 문장도 붙입니다. 오류 문장은 기록할 때와 보낼 때 모두 파일 경로(경로 전체), 이메일 주소, 토큰과 키 같은 비밀값, 웹 주소의 사용자 정보·쿼리·프래그먼트, IP 주소(루프백·미지정 주소 제외)를 `<path>` 같은 자리표시로 가리고 한 줄 300자까지만 남깁니다. 오류 문장은 창, 파일 선택 창, 업데이트, 앱 상태, 화면 표시, 서버 연결, 음성 입력의 오류에만 붙이고, 파일, 에이전트 대화, 노트, 녹취록, Git, 터미널, SSH처럼 사용자의 내용이나 이름이 섞일 수 있는 곳의 오류는 문장 없이 코드만 붙입니다. 서버는 신고를 보관하기 전에 오류 문장을 같은 규칙으로 한 번 더 가립니다. 모바일 앱은 오류 문장을 붙이지 않습니다. 대화와 세션 내용, 터미널 화면, 노트와 녹취록, 파일 내용, 위치, 연결된 컴퓨터 목록, 앱의 로그 파일은 보내지 않습니다. 다만 데스크톱 앱의 오류 문장에는 가리기 규칙에 없는 파일 이름이나 상대 경로, 기기·워크스페이스 이름이 남을 수 있습니다. 앱은 보내기 전에 붙일 정보를 화면에 그대로 보여 주고, 최근 오류 기록은 끄고 보낼 수 있습니다. 신고는 버그를 고치는 데만 씁니다. 처리를 마친(닫은) 신고는 90일 뒤에 지우고, 늦어도 접수 후 1년이 지나면 지웁니다. 계정을 지우면 바로 지웁니다. **이메일로 답장 받기**를 켠 신고에만 계정의 이메일 주소로 답장합니다. 모바일 앱에서 보내지 못한 신고는 기기 백업에 들어가지 않는 앱 캐시에 남겨 두었다가, 보내거나 버리거나 로그아웃하거나 계정을 지우면 지웁니다. 데스크톱 앱은 신고도, 신고에 붙일 최근 오류 기록도 디스크에 남기지 않습니다.
- **모바일 앱**: 채팅과 노트에 붙일 사진은 사용자가 고른 것만 읽어 종단간 암호화해 컴퓨터로 보냅니다. 카메라는 기기를 연결할 때 QR 코드를 읽는 데만 씁니다. QR 코드 내용은 기기 안에서 읽고, 카메라 화면은 저장하거나 보내지 않습니다. 마이크는 음성 입력에 씁니다. 컴퓨터에서 음성 입력을 할 때처럼 소리는 서버를 거쳐 Soniox로 보냅니다.
- **푸시 알림**을 iOS 앱에서 켜면 서버는 푸시 토큰, 알림 언어와 종류를 기기 정보와 함께 보관합니다. 에이전트가 승인이나 답을 기다리면 Apple 푸시 알림 서비스(APNs)를 통해 알림을 보낼 수 있습니다. 알림에는 “승인을 기다리는 요청이 있습니다” 같은 정해진 문구만 표시합니다. 세션 제목, 컴퓨터 이름, 명령, 경로, 대화 내용은 알림에 들어가지 않습니다. 중복 발송을 막으려고 알림마다 무작위 식별자를 하루 동안 보관한 뒤 다음 정리 때 지웁니다. 알림 끄기, 로그아웃, 기기 제거, 계정 삭제가 서버에서 처리되면 등록 정보를 지웁니다. Apple이 무효라고 알린 토큰도 지웁니다.
- **운영 기록**: 서버는 Cloudflare에서 돌아갑니다. 앱은 AWS Lightsail(서울)의 중계 서버를 먼저 거쳐 Cloudflare에 연결하며, 중계 서버는 접속 기록을 남기지 않습니다. Cloudflare의 요청 처리 기록(시각, 경로, 결과, IP 주소, 앱 종류와 버전, 계정·기기 식별자 같은 접속 정보)은 오류를 찾고 남용을 막는 데만 쓰며 Cloudflare에 며칠 동안 남습니다. 로그인 시도가 지나치게 많은 곳을 막으려고 접속한 네트워크를 잠시 셉니다.

Soniox는 받은 소리와 글을 모델 학습에 쓰지 않습니다.

### 관리 화면

개발자는 관리 화면에서 가입 요청을 승인하거나 거절하고, 계정을 관리하고, 버그 신고를 처리합니다.

- **보는 정보**: 가입 요청과 계정의 이메일 주소, 이름, 로그인 방식, 상태, 요청·가입·승인 시각, 마지막 접속 시각(1시간 단위), 기기 이름과 운영체제, 기기별 로그인·접속 시각, 그달의 음성 사용 시간, 계정 비밀번호를 정했는지 같은 상태를 봅니다. 버그 신고는 설명, 앱이 붙인 정보, 신고를 보낸 기기의 플랫폼, 답장 동의 여부, 신고한 계정의 이메일 주소를 봅니다. 요청과 계정, 버그 신고에는 200자까지 메모를 남길 수 있습니다.
- **보지 못하는 정보**: 관리 화면에는 원격 내용, 받아쓴 글, 음성 인식 단어, 계정 키가 나오지 않습니다.
- **정지**: 계정을 정지하면 모든 기기에서 로그아웃되고, 정지가 풀릴 때까지 로그인할 수 없습니다. 계정 정보와 잠긴 계정 키는 그대로 남습니다. 정지하지 않고 모든 기기에서 로그아웃시킬 수도 있습니다.
- **삭제**: 개발자는 정지된 계정만 지울 수 있고, 아래 [계정 삭제](#계정-삭제)와 같이 지웁니다. 다시 요청하지 못하게 할 때는 로그인한 서비스와 계정 식별자, 이메일 주소, 이름을 거절된 요청으로 30일 동안 남깁니다.
- **관리 기록**: 개발자가 한 일(언제, 어느 요청이나 계정, 버그 신고에 무엇을 했는지와 ab\*\*\*@example.com처럼 일부만 남긴 이메일 주소)을 작업한 때부터 1년 동안 보관합니다. 계정을 지워도 이 기록은 그때까지 남습니다.

### 계정 삭제

앱의 **설정 → 원격**에서 계정을 지우면 위 정보를 바로 지우고, Soniox에 남은 노트 녹음과 글은 한 시간 안에 지웁니다. 가입 승인도 함께 지워지므로, 다시 쓰려면 가입을 다시 요청해야 합니다. 다만 계정을 지웠다 다시 만들어 사용 한도를 되돌리지 못하도록, 그달에 쓴 시간만 로그인 계정 식별자의 해시와 함께 그달 말까지 남깁니다.

정지된 계정은 앱에서 지울 수 없습니다. 아래 [문의](#문의)로 삭제를 요청하면 개발자가 지웁니다.

### 처리를 맡기는 곳과 국외 이전

계정 기능을 쓰는 동안 아래 회사가 정보를 처리합니다. Amazon Web Services의 중계 서버는 대한민국 서울에 있고, 나머지 회사의 서버는 대한민국 밖에 있습니다. 정보는 해당 기능을 쓸 때 네트워크로 전송됩니다. 로그인하지 않거나 해당 기능을 쓰지 않으면 보내지 않습니다.

중계 서버는 전송 암호화(TLS)를 풀어 Cloudflare 서버와 같은 정보를 볼 수 있습니다. 여기에는 로그인 토큰, 음성과 받아쓴 글, 잠긴 계정 키가 포함됩니다. 원격 내용은 종단간 암호화된 채로 전달됩니다.

| 받는 곳 | 하는 일 | 위치 | 받는 정보 | 보관 기간 |
|---|---|---|---|---|
| Amazon Web Services, Inc. | 연결 중계 | 대한민국(서울) | 위 계정 정보와 음성(전달만) | 저장하지 않음 |
| Cloudflare, Inc. | 서버와 데이터베이스 운영 | 미국 등 Cloudflare의 데이터 센터 | 위 계정 정보, 원격의 암호화된 내용(전달만) | 계정을 지울 때까지(가입 요청, 버그 신고, 관리 기록은 위에 적은 기간) |
| Soniox | 음성 인식 | 미국 | 음성 입력과 노트 녹음의 소리, 노트 녹음 파일, 음성 인식 단어 | 실시간 소리는 받아쓰는 동안, 녹음 파일과 그 녹취록은 최대 하루 |
| Google, GitHub | 로그인 | 미국 | 사용자가 그 서비스에서 직접 로그인합니다 | 각 서비스의 방침에 따름 |
| Apple Inc. | 로그인, 푸시 알림 전달 | 미국 등 | Apple에서 직접 로그인(계정을 지울 때 Apple에 토큰 폐기 요청) · 휴대폰의 푸시 토큰, 정해진 알림 문구와 종류 | 로그인은 Apple의 방침에 따름 · 푸시는 전달 대기 중 임시 보관(최대 15분으로 설정) |

## 업데이트 확인

Microsoft Store에서 설치한 앱은 Store가 업데이트하며, 앱이 따로 새 버전을 확인하지 않습니다. macOS와 Linux 빌드는 앱을 켤 때와 켜져 있는 동안 4시간마다 GitHub Releases(github.com)에서 새 버전 정보를 받아 옵니다. 이때 GitHub은 일반 웹 요청처럼 IP 주소 같은 접속 정보를 볼 수 있습니다. **설정 → 정보** 에서 자동 확인을 끌 수 있습니다. 릴리스 노트를 열 때도 같은 곳에서 최근 릴리스 목록을 받아 옵니다.

## 다른 서비스

Microsoft Store, Apple App Store, Amazon Web Services, Cloudflare, Soniox, GitHub, Google, 그리고 사용자가 접속하는 호스트와 웹 사이트는 각자의 개인정보처리방침을 따릅니다.

## 문의

- 계정·개인정보 문의: <support@gradiendo.com>
- 버그 신고: 앱의 **설정 → 정보 → 버그 신고**(로그인했을 때)
- 버그와 기능 제안: <https://github.com/moreih29/nexus-code/issues>

## 변경

이 방침이 바뀌면 이 문서를 고치고 시행일을 갱신합니다.

---

# NexusCode Privacy Policy

Effective November 24, 2026

NexusCode sends no usage statistics or analytics to its developer. Error information is sent only when you send a bug report. The app works without signing in, and then it does not talk to any server the developer runs, except to list the ways to sign in when you open **Settings → Remote**; that request carries nothing about you or your device. Only when you sign in to a NexusCode account to use remote, voice input, note recording, the mobile app or bug reports does the information under [NexusCode account](#nexuscode-account) go through the developer's server (the "server").

## What stays on your device

App state such as settings, the workspace list and open tabs, and your notes (text, files, drawings and recordings), are stored only in the app's data folder on this device and in the `.nexus-code` folder in your home folder. Your sign-in token and account key are encrypted with your operating system's key store (the macOS Keychain, the Windows Data Protection API, a Linux keyring) and stored only in the app's data folder on this device. On Linux without a keyring they are not stored, and are remembered only until the app quits. When you uninstall the app installed from the Microsoft Store, its data folder is removed with it.

## Connections made only when you ask

- **SSH workspaces**: the app connects to the hosts you name and copies the NexusCode agent that remote work needs to your home folder there (`~/.nexus-code`). Passwords and key passphrases are used to connect and are not stored.
- **Git**: fetching, pushing and similar operations talk to the remotes you configured. Git (and Git Credential Manager) handles the sign-in.
- **Browser tab**: the app loads the web pages you open. A search term typed in the address bar, rather than a URL, goes to Google Search.
- **Links**: links and buttons such as "Download Git" open in your default browser.

## NexusCode account

What the server handles when you sign in and use account features.

- **Sign-up requests**: your first sign-in does not make an account; it leaves a request to join. The request keeps the service you signed in with, your account's identifier at that service, your email address, your name if provided, when you asked, and how many times and when you last tried. If the developer approves it, your next sign-in makes your account. A pending request is deleted 90 days after your last try. A declined request is kept for 30 days, and until then you cannot ask again. An approved request is deleted if you do not sign in within 30 days of the approval, or 30 days after your account is made.
- **Sign-in** with Google, GitHub or Apple gives the server your email address, your name if provided (on the first sign-in with Apple), and your account's identifier at that service. The server uses these to make your account and keeps them until you delete it. If you choose Hide My Email with Apple, the server stores the relay address as your email address. It keeps any Apple refresh token so it can request revocation when you delete your account. It also keeps your account's status (active or suspended), when it was approved and when it was last used (to the hour) until you delete it.
- **Devices**: for each device signed in, the server keeps its name (your computer's or phone's), its operating system, when it signed in and when it was last seen (to the hour). A sign-in ends after 30 days unused or 180 days after it was made, and the device's details go with it. A name you gave the device yourself is kept for 180 days after its sign-in ends, so that it comes back if the same app signs in again. Sign-in tokens are stored only as hashes.
- **Account password and end-to-end encryption**: your account password is never sent to the server. The account key your devices share is locked with it on your device before the server keeps it, and the server cannot open it.
- **Remote**: what passes between your devices (agent sessions, terminal screens, files, photos) is end-to-end encrypted and relayed by the server. The server can tell only which device it goes from and to, its size and its time; it cannot read it and does not store it.
- **Voice input**: while you speak, the sound goes through the server to the speech-to-text service Soniox, which transcribes it as you speak. The server does not store the sound or the transcript. It records how long you used voice input. The server keeps the **speech recognition words** you add until you delete your account. It sends the list to Soniox along with the audio for transcription.
- **Note recording**: while you record, the sound goes to Soniox and is transcribed as voice input is, with voices told apart so the text is split by speaker (it does not identify anyone). The app also tells the voices apart on your computer by how they sound: it works out a voice print of each line there, which never leaves the computer, is kept in memory only while you record, and is not saved. After the recording, its file may go once more through the server to Soniox for a more accurate text. The file is deleted as soon as its text is ready, the text once the app has it, and both within a day of the file being sent at the latest. Until then the server keeps only the recording's length and how far its transcription is.
- **Usage**: the time you used voice input and note recording is recorded each month.
- **Bug reports**: when you send a report from **Settings → About → Report a bug** in the mobile or desktop app, the server keeps what you wrote, what the app adds and the platform of the device that sent it (such as `ios` or `darwin`), linked to your account. Only a signed-in account can send one. The app adds its version (and, on a phone or tablet, its build number), the operating system and its version (on a computer, its name and version, as in `macOS-26.1`), the kind of device (phone, tablet or computer), a phone's or tablet's model identifier (such as iPhone16,2 or iPad14,1), a computer's CPU type (such as arm64), the version of the remote protocol the app speaks, and the app's language. Unless you turn them off, it also adds its recent errors: up to the last 20, each with its area, error code, HTTP status and how many seconds ago it happened, kept in the app's memory only, never saved, and gone when the app quits. An error's code can include the kind of request or operation that failed (such as its method name). The desktop app puts an error that keeps coming back into one entry with a count, and also adds the error's message. When it records the message and again when it sends it, it hides file paths (whole), email addresses, secrets such as tokens and keys, a web address's user, query and fragment, and IP addresses (except loopback and unspecified addresses) behind placeholders such as `<path>`, and keeps one line of at most 300 characters. Only errors from windows, file pickers, updates, app state, page display, the server connection and voice input carry a message; errors from files, agent conversations, notes, transcripts, Git, terminals, SSH and other places where your content or names can appear go with their code alone. The server hides the same things in each message once more before it keeps the report. The mobile app adds no error messages. Conversation and session content, terminal screens, notes and transcripts, file contents, location, the list of linked computers and the app's log files are not sent. A desktop error's message can still hold a file name, a relative path, or a device or workspace name that the hiding rules miss. The app shows what it adds, as it will be sent, before you send, and you can send without the recent errors. Reports are used only to fix bugs. A report is deleted 90 days after it is closed, and a year after it was received at the latest, and at once when you delete your account. The developer replies by email, to your account's address, only to a report sent with **Reply by email** (on mobile, **Reply to me by email**) on. A report the mobile app could not send stays in the app's cache, which device backups leave out, until it is sent or discarded, you sign out or you delete your account. The desktop app keeps neither a report nor the recent errors it would add on disk.
- **Mobile app**: it reads only the photos you choose to attach to chats and notes and sends them end-to-end encrypted to your computer. It uses the camera only to scan QR codes when you link devices. It reads the QR code on the device without saving or sending the camera image. It uses the microphone for voice input. The audio goes through the server to Soniox, as it does on a computer.
- When you turn on **push notifications** in the iOS app, the server keeps the push token, notification language and kinds with your device's details. When an agent is waiting for approval or an answer, the server can send a notification through the Apple Push Notification service (APNs). It shows only a fixed message such as “A request is waiting for your approval.” Notifications contain no session titles, computer names, commands, paths or conversation content. To prevent duplicates, the server keeps a random identifier for each notification for a day and deletes it at the next cleanup. The server deletes the registration when it processes a request to turn notifications off, a sign-out, device removal or account deletion. It also deletes tokens Apple reports as invalid.
- **Operational logs**: the server runs on Cloudflare. The app connects to Cloudflare through a relay on AWS Lightsail in Seoul, which keeps no access logs. Records of the requests the Cloudflare server handles (time, path, result and connection details such as your IP address, the app and its version, and account and device identifiers) are used only to find faults and stop abuse, and stay with Cloudflare for a few days. To stop excessive sign-in attempts, the server briefly counts requests from each network.

Soniox does not use the sound or text it receives to train its models.

### Admin console

The developer approves or declines sign-up requests, manages accounts and handles bug reports in an admin console.

- **What it shows**: for requests and accounts, the email address, name, sign-in method, status, when the request, account and approval were made, when the account was last used (to the hour), each device's name, operating system and sign-in and last-seen times, the month's voice usage, and states such as whether an account password is set. For a bug report, it shows the description, what the app added, the platform of the device that sent it, whether a reply was asked for, and the reporting account's email address. The developer can add a note of up to 200 characters to a request, an account or a bug report.
- **What it does not show**: the admin console does not show remote content, transcribed text, speech recognition words or account keys.
- **Suspension**: suspending an account signs it out on every device, and it cannot sign in until the suspension is lifted. Its account information and locked account key stay. The developer can also sign an account out on every device without suspending it.
- **Deletion**: the developer can delete only a suspended account, and deletes it as described under [Deleting your account](#deleting-your-account). To keep it from asking to join again, the developer can keep its sign-in service, identifier at that service, email address and name as a declined request for 30 days.
- **Admin log**: what the developer did (when, to which request, account or bug report, and what, with the email address shortened as in ab\*\*\*@example.com) is kept for a year from when it was done, even if the account is deleted.

### Deleting your account

Deleting your account in the app (**Settings → Remote**) deletes the information above at once, and note recordings and text left at Soniox within an hour. Your approval to join goes with it, so to use your account again you need to ask to join again. So that deleting and re-creating an account cannot reset the usage allowance, only the time used that month stays, with a hash of your sign-in's identifier, until the month ends.

A suspended account cannot be deleted in the app. Ask for its deletion under [Contact](#contact), and the developer deletes it.

### Processors and transfers abroad

While you use account features, the companies below process your information. The Amazon Web Services relay is in Seoul, Republic of Korea. The other companies' servers are outside the Republic of Korea. The information is sent over the network when you use the feature concerned. The app does not send it if you do not sign in or do not use the feature.

The relay decrypts the TLS connection and can see the same information as the Cloudflare server. This includes sign-in tokens, audio and transcribed text, and locked account keys. Remote content passes through with its end-to-end encryption intact.

| Recipient | Role | Location | What it receives | Kept for |
|---|---|---|---|---|
| Amazon Web Services, Inc. | Connection relay | Republic of Korea (Seoul) | The account information and voice data above (relayed only) | Not stored |
| Cloudflare, Inc. | Runs the server and its database | Cloudflare data centers, including in the US | The account information above, and remote's encrypted content (relayed only) | Until you delete your account (sign-up requests, bug reports and the admin log: as above) |
| Soniox | Speech-to-text | United States | The sound of voice input and note recording, note recordings' files, and speech recognition words | Live audio for the duration of transcription. Files and their text for up to a day. |
| Google, GitHub | Sign-in | United States | You sign in at their service directly | As their policies say |
| Apple Inc. | Sign-in, push notification delivery | United States and elsewhere | Direct sign-in at Apple (the server asks Apple to revoke the token on account deletion) · Phone push token, fixed notification text and kind | Sign-in follows Apple's policy · Push notifications are held for delivery (delivery window set to at most 15 minutes) |

## Update checks

The Microsoft Store updates the app installed from it; that app does not check for new versions itself. The macOS and Linux builds read new version information from GitHub Releases (github.com) when the app starts and every 4 hours while it runs; as with any web request, GitHub can see connection details such as your IP address. You can turn automatic checks off in **Settings → About**. Opening the release notes reads the recent releases from the same place.

## Other services

The Microsoft Store, the Apple App Store, Amazon Web Services, Cloudflare, Soniox, GitHub, Google, and the hosts and websites you connect to follow their own privacy policies.

## Contact

- Account and privacy questions: <support@gradiendo.com>
- Bug reports: **Settings → About → Report a bug** in the app (when signed in)
- Bugs and feature requests: <https://github.com/moreih29/nexus-code/issues>

## Changes

If this policy changes, this document is updated along with its effective date.
