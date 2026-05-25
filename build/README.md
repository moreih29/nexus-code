# build/

이 디렉터리는 electron-builder의 `buildResources` 경로(`electron-builder.yml` → `directories.buildResources: build`)로 지정되어 있다.

## 아이콘

**아직 아이콘 파일이 없다.** 향후 아이콘을 추가할 때 아래 경로에 파일을 배치하면 electron-builder가 자동으로 인식한다.

| 파일 | 용도 |
|------|------|
| `build/icon.icns` | macOS 앱 아이콘 (권장: 1024×1024 기준 다중 크기 포함) |
| `build/icon.ico` | Windows 앱 아이콘 (향후 대응 시) |
| `build/icon.png` | Linux 앱 아이콘 (512×512 PNG, 향후 대응 시) |

macOS용 `.icns` 파일은 `iconutil` 또는 [Image2icon](https://apps.apple.com/app/image2icon/id992115977) 등을 이용해 생성할 수 있다.

## 서명 / 공증

현재 Phase 1은 ad-hoc 서명(`mac.identity: null`)이다.
유료 Apple Developer Program 등록 후 서명·공증으로 전환할 때는 `build/entitlements.mac.plist`를 채우고 `electron-builder.yml`의 `mac.identity` 및 `mac.notarize` 항목을 업데이트한다.
