# 미래 작업 — Apple Developer 서명 전환 가이드

현재 Nexus Code는 `identity: null` / `notarize: false` (ad-hoc 서명, 공증 없음)으로 배포된다.
이 문서는 정식 Apple Developer 서명 + 공증 체계로 전환할 시점과 절차를 기록한다.

## 전환 트리거 시점

아래 조건 중 하나라도 충족될 때 전환을 검토한다.

- 사용자 베이스가 늘어 Gatekeeper 우회 안내가 상시 운영 부담이 될 때.
- App Store 배포 또는 Enterprise 정책 요구가 생길 때.
- First-run UX 마찰(우회 절차)이 피드백·이탈의 주요 원인으로 확인될 때.

---

## 5단계 전환 절차

### 1. Apple Developer Program 가입 및 인증서 발급

1. [developer.apple.com](https://developer.apple.com)에서 Apple Developer Program에 등록한다 (연간 $99 USD).
2. **Certificates, IDs & Profiles** → **Certificates** → `+` 버튼 → **Developer ID Application** 인증서를 생성한다.
3. `.p12` 파일로 내보내고 비밀번호를 설정한다.
4. [appleid.apple.com](https://appleid.apple.com) → **Sign-In and Security** → **App-Specific Passwords**에서 공증용 앱 전용 비밀번호를 생성한다.

### 2. `electron-builder.yml` 수정

`mac` 섹션에서 아래 두 줄을 변경한다.

```yaml
# 변경 전
mac:
  identity: null
  notarize: false

# 변경 후
mac:
  # identity는 CSC_LINK/CSC_KEY_PASSWORD 환경변수로 자동 주입됨 — 명시 불필요
  notarize: true
```

`notarize: true`로 설정하면 electron-builder가 패키징 후 Apple 공증 서버에 자동 제출한다.

### 3. `build/entitlements.mac.plist` 작성

서명 시 적용할 entitlements 파일이 필요하다. `build/entitlements.mac.plist`에 아래 내용을 작성한다.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <!-- JIT 컴파일 허용 (V8 / Monaco 렌더러 필요) -->
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <!-- 서명되지 않은 실행 가능 메모리 허용 (node-pty 등) -->
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <!-- 동적 라이브러리 유효성 검사 완화 (네이티브 모듈) -->
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
  <!-- dyld 환경변수 허용 (Electron 내부 사용) -->
  <key>com.apple.security.cs.allow-dyld-environment-variables</key>
  <true/>
</dict>
</plist>
```

자식 프로세스(에이전트)에 동일 entitlements를 상속하려면 `build/entitlements.mac.inherit.plist`를 동일 내용으로 복사한다.

`electron-builder.yml`에 entitlements 경로를 등록한다.

```yaml
mac:
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.inherit.plist
```

### 4. GH Actions `release.yml`에 secrets 등록

GitHub 저장소 → **Settings → Secrets and variables → Actions**에서 아래 secrets를 등록한다.

| Secret 이름 | 값 |
|---|---|
| `APPLE_ID` | Apple ID 이메일 주소 |
| `APPLE_APP_SPECIFIC_PASSWORD` | 1단계에서 발급한 앱 전용 비밀번호 |
| `APPLE_TEAM_ID` | Apple Developer 팀 ID (10자리) |
| `CSC_LINK` | `.p12` 파일을 base64 인코딩한 문자열 (`base64 -i cert.p12`) |
| `CSC_KEY_PASSWORD` | `.p12` 내보내기 시 설정한 비밀번호 |

`release.yml`의 `package` job `env` 섹션에 아래를 추가한다.

```yaml
env:
  NEXUS_CHANNEL: ${{ github.event.release.prerelease && 'beta' || 'stable' }}
  GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  APPLE_ID: ${{ secrets.APPLE_ID }}
  APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
  APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
  CSC_LINK: ${{ secrets.CSC_LINK }}
  CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}
```

### 5. `electron-updater` 풀 통합 전환 (점진적)

현재 `src/main/features/updates/`는 자체 업데이트 체크 로직을 가진다.
서명 전환 후 `electron-updater` 라이브러리의 전체 기능(자동 다운로드, 설치 후 재시작)을 점진적으로 통합한다.

- `AppState` 키 `updateChannel`과 `ignoredUpdateVersion`은 그대로 유지한다.
- 키 이름이 동일하므로 사용자 설정 마이그레이션 코드가 필요하지 않다.
- 통합 범위: `autoUpdater.channel` ← `updateChannel`, `autoUpdater.allowPrerelease` ← `channel === 'beta'`.
