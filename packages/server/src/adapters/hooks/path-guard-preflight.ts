import { extractPaths, normalizePath, isProtected } from '@nexus/shared'

export interface PreflightResult {
  protectedPaths: string[]
  parseReason?: string // path 추출 실패 시 원인 (로깅용)
}

export async function preflightPaths(
  toolName: string,
  toolInput: unknown,
  workspacePath: string,
): Promise<PreflightResult> {
  const extracted = extractPaths(toolName, toolInput)

  if (extracted.kind === 'empty') {
    return { protectedPaths: [] }
  }

  if (extracted.kind === 'unparseable') {
    // Bash 파서가 포기한 경우 — 경로 자체를 모름, protected 여부 판정 불가
    // Bridge는 이 정보로 모드 판정 + ask로 폴백
    return { protectedPaths: [], parseReason: extracted.reason }
  }

  // kind === 'paths'
  const normalized = await Promise.all(
    extracted.paths.map((p) => normalizePath(p, workspacePath)),
  )

  const protectedPaths = normalized.filter((abs) => isProtected(abs, workspacePath))

  return { protectedPaths }
}
