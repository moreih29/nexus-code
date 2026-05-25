# macOS 13 (x64) GitHub Actions runner sunset 모니터링

## 상태 (2026-05 시점)

`.github/workflows/release.yml`의 package job matrix에서 Intel Mac(x64) 빌드는 `macos-13` runner를 사용한다. GitHub Actions가 macOS runner를 매년 새 메이저로 교체하면서 macos-13는 deprecation 일정이 진행 중이다.

```yaml
matrix:
  include:
    - runner: macos-14   # Apple Silicon (arm64)
      arch: arm64
    - runner: macos-13   # Intel (x64) — sunset 예정
      arch: x64
```

## 모니터링 대상

- GitHub Actions changelog: https://github.blog/changelog/label/actions
- GitHub Actions runner-images repo: https://github.com/actions/runner-images
- "macos-13" 또는 "macOS 13" deprecation 공지

매 분기 1회 점검 권장. sunset 6개월 전에 공지가 보통 나온다.

## sunset 시 대응 옵션

**A. macos-14에서 x64 cross-compile 재평가**
- `electron-rebuild --arch=x64`가 macos-14(arm64) 위에서 native module을 정상 빌드하는지 검증.
- `better-sqlite3`, `node-pty`의 prebuild-install + binding.gyp `-arch` 플래그 동작 확인.
- 성공하면 matrix를 macos-14 단일로 통합 + 한 runner에서 두 arch 빌드.
- 단일 runner cross-rebuild는 `@electron/rebuild` 또는 `prebuild-install`의 캐시 충돌 위험이 있어 직접 검증 필수.

**B. Intel Mac 빌드 중단**
- Apple Silicon만 지원하는 경로. 사용자에게 Rosetta 2로 Intel Mac에서 arm64 빌드 실행 안내.
- Rosetta는 native module의 fat binary 일부 시나리오에서 충돌 가능 → 사전 테스트 필수.
- `electron-builder`의 `mac.target.arch`를 `[arm64]`로 축소.
- README/INSTALL.md에서 Intel Mac 다운로드 안내 제거.

**C. 다른 hosted runner / 자체 호스팅**
- GitHub Actions의 macOS hosted runner 외 옵션(예: BuildJet, self-hosted)으로 Intel runner 확보.
- 비용·관리 부담 증가 — 사용자 베이스가 Intel 비중이 클 때만 고려.

## 결정 트리거

- macos-13 sunset 공지가 나온 시점 또는 sunset 6개월 전.
- 그 사이 새 0.X.0 메이저 릴리스가 있다면 그 시점에 다시 평가.

## 결정자

Lead. 비즈니스 판단(Intel 사용자 비중)이 핵심 변수.
