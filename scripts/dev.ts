#!/usr/bin/env bun
/**
 * Dev orchestrator — shared 빌드 → 서버 + 웹 시작 → 일렉트론 실행
 */
import { spawn, type Subprocess } from 'bun'
import { resolve } from 'path'

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
  stdout: 'inherit',
  stderr: 'inherit',
})
procs.push(server)

log('Starting web...')
const web = spawn({
  cmd: ['bun', 'run', 'dev'],
  cwd: resolve(root, 'packages/web'),
  stdout: 'inherit',
  stderr: 'inherit',
})
procs.push(web)

// 2. 서버 + 웹 준비 대기
log('Waiting for server + web...')
// 127.0.0.1 명시: localhost가 IPv6(::1)로 resolve될 때 Bun fetch가 hang되는 이슈 회피
await Promise.all([
  waitFor('http://127.0.0.1:3000/api/health'),
  waitFor('http://127.0.0.1:5173/'),
])
log('Server + Web ready')

// 3. 일렉트론 빌드 및 실행
log('Launching electron...')
const electron = spawn({
  cmd: ['bun', 'run', 'dev'],
  cwd: resolve(root, 'packages/electron'),
  stdout: 'inherit',
  stderr: 'inherit',
})
procs.push(electron)

// 일렉트론 종료 시 전체 정리
await electron.exited
log('Shutting down...')
cleanup()
