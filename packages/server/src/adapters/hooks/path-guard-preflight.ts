import { extractPaths, normalizePath, isProtected, isWithinAllowedRoots } from '@nexus/shared'

export interface PreflightResult {
  protectedPaths: string[]
  parseReason?: string // path 추출 실패 시 원인 (로깅용)
  bashFsSubset: boolean // Bash 도구이고 모든 경로가 cwd 내부인 경우
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
  const normalized = await Promise.all(
    extracted.paths.map((p) => normalizePath(p, workspacePath)),
  )

  const protectedPaths = normalized.filter((abs) => isProtected(abs, workspacePath))

  // bashFsSubset 판정: Bash 도구이고 모든 경로가 cwd 내부
  const bashFsSubset =
    toolName === 'Bash' && normalized.every((abs) => isWithinAllowedRoots(abs, [workspacePath]))

  return { protectedPaths, bashFsSubset }
}
