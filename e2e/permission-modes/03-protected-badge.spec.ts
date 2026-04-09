/**
 * E2E: Protected path 배지 + scope 숨김
 *
 * TODO: mock 인프라 구축 후 활성화
 *
 * 활성화 조건:
 * 1. @playwright/test 설치
 * 2. playwright.config.ts 작성
 * 3. SSE mock 서버 — permission_request 이벤트 발행 가능해야 함
 *    (protectedHint 메타데이터 포함)
 *
 * 수동 검증 단계: e2e/permission-modes/README.md 시나리오 3 참조
 */

import { test, expect } from '@playwright/test'

test.skip('protected path 배지 + scope 버튼 숨김 (.env 쓰기)', async ({ page }) => {
  // ── 전제 조건 ──────────────────────────────────────────────────────────────
  // SSE mock: /api/events/:sessionId 스트림에서 permission_request 이벤트 발행
  // {
  //   type: 'permission_request',
  //   sessionId: '<id>',
  //   toolName: 'Write',
  //   toolInput: { file_path: '/tmp/workspace/.env' },
  //   protectedHint: ['/tmp/workspace/.env'],
  //   reason: '보호 경로',
  //   source: 'protected',
  // }

  await page.goto('/')

  // ── 1. 워크스페이스 선택 ────────────────────────────────────────────────────
  const firstWorkspace = page.locator('[data-testid="workspace-card"]').first()
  await firstWorkspace.waitFor({ timeout: 5000 })
  await firstWorkspace.click()

  // ── 2. status-bar → "기본" 선택 ─────────────────────────────────────────────
  const permModeBtn = page.locator('[data-testid="status-bar-permission-mode"]')
  await permModeBtn.click()

  const defaultItem = page.locator('[data-testid="permission-mode-default"]')
  await defaultItem.click()

  await expect(permModeBtn).toContainText('기본')

  // ── 3. chat 입력 + 전송 ─────────────────────────────────────────────────────
  const chatInput = page.locator('[data-testid="chat-input"]')
  await chatInput.fill('.env 파일을 만들어서 API_KEY=test 값을 넣어줘')
  await chatInput.press('Enter')

  // ── 4. permission-block 카드 렌더링 + 배지/라인 확인 ────────────────────────
  const permissionBlock = page.locator('[data-testid="permission-block"]').last()
  await permissionBlock.waitFor({ timeout: 5000 })

  // 🔒 "보호 경로" 배지
  await expect(permissionBlock.locator('text=보호 경로')).toBeVisible()

  // 좌측 2px red 라인 (CSS 검사)
  const cardElement = await permissionBlock.elementHandle()
  const borderLeft = await cardElement?.evaluate((el) =>
    window.getComputedStyle(el).borderLeftWidth,
  )
  expect(borderLeft).toBe('2px')

  // ── 5. scope split 버튼 → 단일 "승인(1회)" 버튼으로 대체 ───────────────────
  // split 버튼 (이번만 / 세션 / 영구)이 **없어야** 함
  await expect(permissionBlock.locator('[data-testid="scope-session"]')).toHaveCount(0)
  await expect(permissionBlock.locator('[data-testid="scope-permanent"]')).toHaveCount(0)

  // 단일 "승인 (1회)" 버튼만 노출
  const approveOnceBtn = permissionBlock.locator('[data-testid="scope-once"]')
  await expect(approveOnceBtn).toBeVisible()
  await expect(approveOnceBtn).toContainText('승인')

  // "보호 경로는 매번 확인합니다" 설명 텍스트
  await expect(permissionBlock.locator('text=보호 경로는 매번 확인합니다')).toBeVisible()
})
