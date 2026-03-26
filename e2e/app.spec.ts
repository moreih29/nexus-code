import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { resolve } from 'path'

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  app = await electron.launch({
    args: [resolve(__dirname, '../out/main/index.js')]
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  await app.close()
})

test('app window opens', async () => {
  const title = await page.title()
  expect(title).toBeDefined()
})

test('app window has correct default size', async () => {
  const bounds = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    return win.getBounds()
  })
  expect(bounds.width).toBeGreaterThanOrEqual(1280)
  expect(bounds.height).toBeGreaterThanOrEqual(800)
})

test('screenshot - initial state', async () => {
  await page.screenshot({ path: 'e2e/screenshots/initial.png' })
})
