import { app, BrowserWindow, shell, ipcMain, dialog } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import * as path from 'path'
import { isDev, serverPort, webDevUrl } from './env'
import { logger } from './logger'

let serverProcess: ChildProcess | null = null
let mainWindow: BrowserWindow | null = null

function resolveServerEntry(): string {
  // In production: dist/index.js relative to the app resources
  // In dev: packages/server/dist/index.js relative to this file's location
  const packageRoot = path.resolve(__dirname, '../../server')
  return path.join(packageRoot, 'dist', 'index.js')
}

async function waitForServer(timeoutMs = 10000, intervalMs = 500): Promise<void> {
  const url = `http://localhost:${serverPort}/api/health`
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      // server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  throw new Error(`Server did not become ready within ${timeoutMs}ms`)
}

function spawnServer(): void {
  const entry = resolveServerEntry()

  console.log('[electron] spawning server:', entry)
  logger.info('server spawn', { entry })

  serverProcess = spawn(process.execPath, [entry], {
    env: { ...process.env, NODE_ENV: isDev ? 'development' : 'production' },
    stdio: 'inherit',
  })

  serverProcess.on('error', (err) => {
    console.error('[electron] server process error:', err)
    logger.error('server process error', { message: err.message, stack: err.stack })
  })

  serverProcess.on('exit', (code, signal) => {
    console.log(`[electron] server process exited — code=${code} signal=${signal}`)
    logger.info('server process exited', { code, signal })
    serverProcess = null
  })
}

function killServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!serverProcess) {
      resolve()
      return
    }

    const proc = serverProcess
    serverProcess = null

    const forceKill = setTimeout(() => {
      proc.kill('SIGKILL')
      resolve()
    }, 5000)

    proc.on('exit', () => {
      clearTimeout(forceKill)
      resolve()
    })

    proc.kill('SIGTERM')
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  const loadUrl = isDev ? webDevUrl : `http://localhost:${serverPort}`
  void mainWindow.loadURL(loadUrl)

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

process.on('uncaughtException', (err) => {
  console.error('[electron] uncaughtException:', err)
  logger.error('uncaughtException', { message: err.message, stack: err.stack })
})

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason)
  const stack = reason instanceof Error ? reason.stack : undefined
  console.error('[electron] unhandledRejection:', reason)
  logger.error('unhandledRejection', { message, stack })
})

app.whenReady().then(async () => {
  logger.info('app ready', { isDev, serverPort })
  if (!isDev) {
    spawnServer()
    await waitForServer()
  }
  // dev 모드: 서버는 별도 터미널에서 실행 (bun run --filter @nexus/server dev)
  // Electron은 웹 dev 서버(localhost:5173)만 로드

  ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', async (event) => {
  event.preventDefault()
  await killServer()
  logger.info('app before-quit: server killed, exiting')
  await logger.flush()
  app.exit(0)
})
