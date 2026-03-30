<!-- tags: electron, testing, playwright, MCP, CDP, e2e, automation -->
# Electron 앱 자동화 테스트 방법 (2024-2026)

**Searched**: 2026-03-30

## 핵심 결론

1. **Playwright `_electron` 모듈**: experimental이지만 가장 널리 쓰임. Electron 30+ 호환성 이슈 있음 (CLI 플래그 거부)
2. **WebdriverIO + wdio-electron-service**: Spectron의 공식 후계자. Electron 팀 공식 권장
3. **MCP 서버**: 2024-2025에 electron-mcp, electron-test-mcp 등 AI 에이전트용 도구 다수 등장
4. **CDP 직접 연결**: `app.commandLine.appendSwitch('remote-debugging-port', '9222')` 후 `chromium.connectOverCDP()` 사용 (Electron 30+)

## 제한 사항

- electron-vite localhost 직접 접근: IPC 의존 기능 테스트 불가
- Playwright Electron API는 stable이 아님 (언더스코어 prefix)
- Electron 버전 업 시 playwright 호환성 깨짐 반복 (v27, v30, v36)

## 주요 URL

- Playwright Electron 클래스: https://playwright.dev/docs/api/class-electron
- wdio-electron-service: https://webdriver.io/docs/wdio-electron-service/
- electron-mcp (34+ tools): https://github.com/kanishka-namdeo/electron-mcp
- electron-test-mcp: https://github.com/lazy-dinosaur/electron-test-mcp
- Electron 자동화 테스트 공식 문서: https://www.electronjs.org/docs/latest/tutorial/automated-testing
- electron-playwright-helpers npm: https://www.npmjs.com/package/electron-playwright-helpers
