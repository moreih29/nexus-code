/**
 * E2E: 권한 모드 전환 즉시 반영
 *
 * TODO: mock 인프라 구축 후 활성화
 *
 * 활성화 조건:
 * 1. @playwright/test 설치
 * 2. playwright.config.ts 작성 (baseURL, webServer)
 * 3. /api/settings GET/PUT mock 또는 실제 서버 실행
 *
 * 수동 검증 단계: e2e/permission-modes/README.md 시나리오 1 참조
 */

import { test, expect } from '@playwright/test'

test.skip('권한 모드 전환 — status-bar에서 변경 시 settings 탭에 즉시 반영', async ({ page }) => {
  // ── 전제 조건 ──────────────────────────────────────────────────────────────
  // 서버가 http://localhost:3000 에서 실행 중이어야 함
  // /api/settings?scope=global 이 { permissionMode: 'default' } 반환
  // /api/workspaces 가 최소 1개의 워크스페이스 반환

  await page.goto('/')

  // ── 1. 워크스페이스 선택 ────────────────────────────────────────────────────
  // 워크스페이스 카드가 로드될 때까지 대기
  const firstWorkspace = page.locator('[data-testid="workspace-card"]').first()
  await firstWorkspace.waitFor({ timeout: 5000 })
  await firstWorkspace.click()

  // ── 2. status-bar에서 현재 모드 드롭다운 열기 ──────────────────────────────
  // status-bar의 권한 모드 드롭다운 트리거: 아이콘 + 모드명 + ChevronDown
  const permModeBtn = page.locator('[data-testid="status-bar-permission-mode"]')
  await permModeBtn.click()

  // ── 3. "편집 허용" 선택 ─────────────────────────────────────────────────────
  const acceptEditsItem = page.locator('[data-testid="permission-mode-acceptEdits"]')
  await acceptEditsItem.click()

  // ── 4. status-bar에 변경 반영 확인 ──────────────────────────────────────────
  await expect(permModeBtn).toContainText('편집 허용')

  // ── 5. PUT /api/settings 요청 캡처 ──────────────────────────────────────────
  // mock 인프라 구축 시: page.route('/api/settings*', ...) 로 요청 인터셉트
  // await expect(capturedBody).toMatchObject({ permissionMode: 'acceptEdits' })

  // ── 6. 설정 모달 열기 → 넥서스 탭 ────────────────────────────────────────────
  const settingsBtn = page.locator('[data-testid="status-bar-settings-btn"]')
  await settingsBtn.click()

  // 모달이 열릴 때까지 대기
  await page.locator('[role="dialog"]').waitFor()

  // 넥서스 탭 클릭
  await page.locator('button', { hasText: '넥서스' }).click()

  // ── 7. 라디오 항목이 "편집 허용"으로 선택됐는지 확인 ────────────────────────
  // NexusTab 권한 모드 섹션: checked label은 accent 테두리 스타일
  const acceptEditsLabel = page.locator('label').filter({ hasText: '편집 허용' })
  await expect(acceptEditsLabel).toHaveClass(/border-\[var\(--accent\)\]/)

  // 라디오 input이 checked 상태인지 확인
  const radio = acceptEditsLabel.locator('input[type="radio"][value="acceptEdits"]')
  await expect(radio).toBeChecked()
})
