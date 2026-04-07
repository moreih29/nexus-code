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
      p.kill()
    } catch {}
  }
}

process.on('SIGINT', () => {
  cleanup()
  process.exit(0)
})
process.on('SIGTERM', () => {
  cleanup()
  process.exit(0)
})

async function waitFor(url: string, timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {}
    await Bun.sleep(500)
  }
  throw new Error(`Timeout waiting for ${url}`)
}

const log = (msg: string) => console.log(`\x1b[36m[dev]\x1b[0m ${msg}`)

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
await Promise.all([
  waitFor('http://localhost:3000/api/health'),
  waitFor('http://localhost:5173'),
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
