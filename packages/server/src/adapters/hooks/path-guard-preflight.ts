import { promises as fs } from 'node:fs'
import { extractPaths, normalizePath, isProtected, isWithinAllowedRoots } from '@nexus/shared'

export interface PreflightResult {
  protectedPaths: string[]
  parseReason?: string // path 추출 실패 시 원인 (로깅용)
  bashFsSubset: boolean // Bash 도구이고 모든 경로가 cwd 내부인 경우
}

/**
 * workspacePath를 realpath로 정규화. 심볼릭 링크(macOS /tmp → /private/tmp 등)를
 * 해석해 두지 않으면 `normalizePath`(realpath 해석)와 `isProtected`의 `path.relative()`
 * 계산이 어긋나 워크스페이스 내부 경로가 "바깥"으로 잘못 판정됨.
 */
async function resolveWorkspace(workspacePath: string): Promise<string> {
  try {
    return await fs.realpath(workspacePath)
  } catch {
    return workspacePath
  }
}

export async function preflightPaths(
  toolName: string,
  toolInput: unknown,
  workspacePath: string,
): Promise<PreflightResult> {
  const extracted = extractPaths(toolName, toolInput)

  if (extracted.kind === 'empty') {
    return { protectedPaths: [], bashFsSubset: false }
  }

  if (extracted.kind === 'unparseable') {
    // Bash 파서가 포기한 경우 — 경로 자체를 모름, protected 여부 판정 불가
    // Bridge는 이 정보로 모드 판정 + ask로 폴백
    return { protectedPaths: [], parseReason: extracted.reason, bashFsSubset: false }
  }

  // kind === 'paths'
  const realWorkspace = await resolveWorkspace(workspacePath)
  const normalized = await Promise.all(
    extracted.paths.map((p) => normalizePath(p, realWorkspace)),
  )

  const protectedPaths = normalized.filter((abs) => isProtected(abs, realWorkspace))

  // bashFsSubset 판정: Bash 도구이고 모든 경로가 cwd 내부
  const bashFsSubset =
    toolName === 'Bash' && normalized.every((abs) => isWithinAllowedRoots(abs, [realWorkspace]))

  return { protectedPaths, bashFsSubset }
}
