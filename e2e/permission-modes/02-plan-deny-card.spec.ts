/**
 * E2E: plan 모드 차단 카드
 *
 * TODO: mock 인프라 구축 후 활성화
 *
 * 활성화 조건:
 * 1. @playwright/test 설치
 * 2. playwright.config.ts 작성
 * 3. SSE mock 서버 — permission_denied 이벤트 발행 가능해야 함
 *    (실제 Claude CLI + Anthropic API 호출은 E2E에서 너무 느리고 flaky)
 *
 * 수동 검증 단계: e2e/permission-modes/README.md 시나리오 2 참조
 */

import { test, expect } from '@playwright/test'

test.skip('plan 모드 차단 카드 — Edit 도구 차단 + CTA로 모드 전환', async ({ page }) => {
  // ── 전제 조건 ──────────────────────────────────────────────────────────────
  // SSE mock: /api/events/:sessionId 스트림에서 permission_denied 이벤트 발행
  // {
  //   type: 'permission_denied',
  //   sessionId: '<id>',
  //   toolName: 'Edit',
  //   reason: 'plan 모드에서 편집 차단됨',
  //   source: 'mode',
  // }

  await page.goto('/')

  // ── 1. 워크스페이스 선택 ────────────────────────────────────────────────────
  const firstWorkspace = page.locator('[data-testid="workspace-card"]').first()
  await firstWorkspace.waitFor({ timeout: 5000 })
  await firstWorkspace.click()

  // ── 2. status-bar → "계획" 선택 ─────────────────────────────────────────────
  const permModeBtn = page.locator('[data-testid="status-bar-permission-mode"]')
  await permModeBtn.click()

  const planItem = page.locator('[data-testid="permission-mode-plan"]')
  await planItem.click()

  await expect(permModeBtn).toContainText('계획')

  // ── 3. 채팅 입력 → 전송 ─────────────────────────────────────────────────────
  const chatInput = page.locator('[data-testid="chat-input"]')
  await chatInput.fill('README.md 고쳐줘')
  await chatInput.press('Enter')

  // ── 4. SSE mock이 permission_denied 이벤트를 push함 ─────────────────────────
  // 실제 구현 시: page.route 또는 별도 mock 서버로 SSE 스트림 제어
  // applyServerEvent({ type: 'permission_denied', toolName: 'Edit', ... })

  // ── 5. permission-deny-block 카드 표시 확인 ──────────────────────────────────
  const denyCard = page.locator('[data-testid="permission-deny-block"]')
  await denyCard.waitFor({ timeout: 10_000 })

  // 헤더: "차단됨 — Edit 도구"
  await expect(denyCard).toContainText('차단됨')
  await expect(denyCard).toContainText('Edit')

  // CTA 버튼 존재 확인
  const switchBtn = denyCard.locator('button', { hasText: '편집 허용으로 전환' })
  await expect(switchBtn).toBeVisible()

  const ignoreBtn = denyCard.locator('button', { hasText: '무시하고 계속' })
  await expect(ignoreBtn).toBeVisible()

  // 카드 배경 스타일 확인 (rgba(248,81,73,0.05))
  // CSS 변수로 인해 직접 color 검증은 어려우므로 data-testid 기반 구조 검증으로 대체

  // ── 6. "편집 허용으로 전환" CTA 클릭 ────────────────────────────────────────
  // mock 인프라: PUT /api/settings 요청 인터셉트 준비
  // let capturedBody: unknown
  // await page.route('/api/settings*', async (route) => {
  //   capturedBody = await route.request().postDataJSON()
  //   await route.fulfill({ json: { permissionMode: 'acceptEdits' } })
  // })

  await switchBtn.click()

  // ── 7. status-bar가 "편집 허용"으로 변경됐는지 확인 ─────────────────────────
  await expect(permModeBtn).toContainText('편집 허용', { timeout: 3_000 })

  // PUT 요청 body 검증 (mock 인프라 구축 시)
  // expect(capturedBody).toMatchObject({ permissionMode: 'acceptEdits' })
})
