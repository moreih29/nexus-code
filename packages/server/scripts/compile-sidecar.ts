#!/usr/bin/env bun
/**
 * Sidecar 컴파일 스크립트 — server를 단일 바이너리로 번들하여
 * packages/tauri/src-tauri/binaries/nexus-sidecar-<triple> 출력.
 *
 * Tauri bundler가 externalBin 경로를 플랫폼 triple suffix로 자동 탐색.
 */
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'

type PlatformTriple =
  | 'aarch64-apple-darwin'
  | 'x86_64-apple-darwin'
  | 'x86_64-unknown-linux-gnu'
  | 'x86_64-pc-windows-msvc'

function resolveTriple(): { triple: PlatformTriple; exeSuffix: string } {
  const { platform, arch } = process
  if (platform === 'darwin' && arch === 'arm64') return { triple: 'aarch64-apple-darwin', exeSuffix: '' }
  if (platform === 'darwin' && arch === 'x64') return { triple: 'x86_64-apple-darwin', exeSuffix: '' }
  if (platform === 'linux' && arch === 'x64') return { triple: 'x86_64-unknown-linux-gnu', exeSuffix: '' }
  if (platform === 'win32' && arch === 'x64') return { triple: 'x86_64-pc-windows-msvc', exeSuffix: '.exe' }
  throw new Error(`Unsupported platform/arch: ${platform}/${arch}`)
}

const scriptDir = import.meta.dir
const serverRoot = resolve(scriptDir, '..')
const entry = resolve(serverRoot, 'src/index.ts')
const outDir = resolve(serverRoot, '../tauri/src-tauri/binaries')
const { triple, exeSuffix } = resolveTriple()
const outfile = resolve(outDir, `nexus-sidecar-${triple}${exeSuffix}`)

if (!existsSync(outDir)) {
  await mkdir(outDir, { recursive: true })
}

console.log(`[compile-sidecar] entry=${entry}`)
console.log(`[compile-sidecar] triple=${triple}`)
console.log(`[compile-sidecar] outfile=${outfile}`)

const proc = Bun.spawn({
  cmd: [
    'bun',
    'build',
    entry,
    '--compile',
    '--outfile',
    outfile,
    '--define',
    'process.env.NODE_ENV="production"',
  ],
  stdout: 'inherit',
  stderr: 'inherit',
  env: { ...process.env, NODE_ENV: 'production' },
})

const exit = await proc.exited
if (exit !== 0) {
  console.error(`[compile-sidecar] bun build failed with exit ${exit}`)
  process.exit(exit)
}

const size = Bun.file(outfile).size
console.log(`[compile-sidecar] success — ${(size / 1024 / 1024).toFixed(1)} MB`)
