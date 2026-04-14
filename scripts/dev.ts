#!/usr/bin/env bun
/**
 * Dev orchestrator — shared 빌드 → 서버 + 웹 시작 → tauri dev 실행
 */
import { spawn, type Subprocess } from 'bun'
import { resolve } from 'path'
import { mkdir, appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'

const root = resolve(import.meta.dir, '..')
const procs: Subprocess[] = []

function cleanup() {
  for (const p of procs) {
    try {
      p.kill('SIGTERM')
    } catch {}
  }
  // 2초 후에도 살아있으면 SIGKILL (tsx --watch 등 자식을 orphan화하는 wrapper 대응)
  setTimeout(() => {
    for (const p of procs) {
      try {
        p.kill('SIGKILL')
      } catch {}
    }
    process.exit(0)
  }, 2_000).unref()
}

process.on('SIGINT', () => {
  cleanup()
})
process.on('SIGTERM', () => {
  cleanup()
})

async function assertPortFree(port: number, label: string): Promise<void> {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), 500)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal })
    if (res.ok) {
      console.error(`[dev] ${label} already listening on :${port} — kill orphan first`)
      console.error(`      hint: pkill -f 'tsx.*src/index.ts' && lsof -nP -iTCP:${port} -sTCP:LISTEN`)
      process.exit(1)
    }
  } catch {
    // 기대 경로: 아무도 안 들음
  } finally {
    clearTimeout(t)
  }
}

async function waitFor(url: string, timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), 2_000)
    try {
      const res = await fetch(url, { signal: controller.signal })
      if (res.ok) return
    } catch {}
    clearTimeout(t)
    await Bun.sleep(500)
  }
  throw new Error(`Timeout waiting for ${url}`)
}

const log = (msg: string) => console.log(`\x1b[36m[dev]\x1b[0m ${msg}`)

// ANSI 이스케이프 제거 (로그 파일 영속용)
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '')
}

// 로그 파일 경로 (NEXUS_LOG_DEV=1 시 사용)
const logEnabled = process.env.NEXUS_LOG_DEV === '1'
let logFilePath: string | null = null

if (logEnabled) {
  const date = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const logDir = resolve(homedir(), '.nexus-code', 'logs', '_system')
  await mkdir(logDir, { recursive: true })
  logFilePath = resolve(logDir, `dev-${date}.log`)
}

async function persistLine(line: string): Promise<void> {
  if (!logFilePath) return
  const plain = stripAnsi(line)
  await appendFile(logFilePath, plain + '\n', 'utf8')
}

const MAX_LINE_LENGTH = 64 * 1024 // 64KB cap

// 라인 splitter: ReadableStream<Uint8Array>를 라인 단위로 처리하고 prefix+색상 prepend
async function pipeLines(
  stream: ReadableStream<Uint8Array> | null,
  prefix: string,
  color: string,
): Promise<void> {
  if (!stream) return
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })

    let newlineIdx: number
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, newlineIdx)
      buffer = buffer.slice(newlineIdx + 1)

      // 64KB cap: 매우 긴 라인 truncate
      if (line.length > MAX_LINE_LENGTH) {
        line = line.slice(0, MAX_LINE_LENGTH) + ' …[truncated]'
      }

      const prefixed = `${color}${prefix}\x1b[0m ${line}`
      process.stdout.write(prefixed + '\n')
      await persistLine(prefixed)
    }
  }

  // 스트림 끝: 남은 버퍼 처리 (마지막 줄에 \n 없는 경우)
  // flush remaining decoder bytes
  const tail = decoder.decode()
  buffer += tail
  if (buffer.length > 0) {
    let line = buffer
    if (line.length > MAX_LINE_LENGTH) {
      line = line.slice(0, MAX_LINE_LENGTH) + ' …[truncated]'
    }
    const prefixed = `${color}${prefix}\x1b[0m ${line}`
    process.stdout.write(prefixed + '\n')
    await persistLine(prefixed)
  }
}

// 0-pre. Pre-flight port check — orphan tsx/vite 프로세스 감지해서 조기 실패
log('Checking ports 3000/5173...')
await assertPortFree(3000, 'server')
await assertPortFree(5173, 'web')

// 0. Build shared (서버/웹이 @nexus/shared dist에 의존)
log('Building shared...')
const shared = spawn({
  cmd: ['bun', 'run', 'build'],
  cwd: resolve(root, 'packages/shared'),
  stdout: 'inherit',
  stderr: 'inherit',
})
await shared.exited
if (shared.exitCode !== 0) {
  console.error('[dev] shared 빌드 실패')
  process.exit(1)
}

// 1. 서버 + 웹 동시 시작
log('Starting server...')
const server = spawn({
  cmd: ['bun', 'run', 'dev'],
  cwd: resolve(root, 'packages/server'),
  stdout: 'pipe',
  stderr: 'pipe',
  env: { ...process.env, FORCE_COLOR: '1' },
})
procs.push(server)
pipeLines(server.stdout, '[server]', '\x1b[32m')
pipeLines(server.stderr, '[server]', '\x1b[32m')

log('Starting web...')
const web = spawn({
  cmd: ['bun', 'run', 'dev'],
  cwd: resolve(root, 'packages/web'),
  stdout: 'pipe',
  stderr: 'pipe',
  env: { ...process.env, FORCE_COLOR: '1' },
})
procs.push(web)
pipeLines(web.stdout, '[web]', '\x1b[34m')
pipeLines(web.stderr, '[web]', '\x1b[34m')

// 2. 서버 + 웹 준비 대기
log('Waiting for server + web...')
// 127.0.0.1 명시: localhost가 IPv6(::1)로 resolve될 때 Bun fetch가 hang되는 이슈 회피
await Promise.all([
  waitFor('http://127.0.0.1:3000/api/health'),
  waitFor('http://127.0.0.1:5173/'),
])
log('Server + Web ready')

// 3. tauri dev 실행
log('Launching tauri...')
const tauri = spawn({
  cmd: ['bunx', 'tauri', 'dev'],
  cwd: resolve(root, 'packages/tauri'),
  stdout: 'pipe',
  stderr: 'pipe',
  env: { ...process.env, FORCE_COLOR: '1' },
})
procs.push(tauri)
pipeLines(tauri.stdout, '[tauri]', '\x1b[35m')
pipeLines(tauri.stderr, '[tauri]', '\x1b[35m')

// tauri 종료 시 전체 정리
await tauri.exited
log('Shutting down...')
cleanup()
