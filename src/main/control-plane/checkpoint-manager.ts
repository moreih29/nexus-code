import { execFile } from 'child_process'
import { promisify } from 'util'
import log from '../logger'

const execFileAsync = promisify(execFile)

export interface Checkpoint {
  stashRef?: string
  headHash: string
  sessionId: string
  timestamp: number
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout.trim()
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ['rev-parse', '--is-inside-work-tree'])
    return true
  } catch {
    return false
  }
}

export async function createCheckpoint(cwd: string, sessionId: string): Promise<Checkpoint | null> {
  let headHash: string
  try {
    headHash = await git(cwd, ['rev-parse', 'HEAD'])
  } catch {
    // 커밋이 없는 repo (git init 직후) — 체크포인트 생성 불가
    log.info('[CheckpointManager] 커밋 없는 repo, 체크포인트 스킵', { sessionId })
    return null
  }
  const timestamp = Date.now()
  const label = `nexus-checkpoint-${sessionId}-${timestamp}`

  // 변경사항 확인 (untracked 포함)
  const statusOut = await git(cwd, ['status', '--porcelain'])
  if (!statusOut) {
    // 클린 트리 — HEAD 해시만 기록
    log.info('[CheckpointManager] 클린 트리, HEAD만 기록', { sessionId, headHash })
    return { headHash, sessionId, timestamp }
  }

  // stash 생성
  await git(cwd, ['stash', 'push', '-m', label, '--include-untracked'])

  // 작업 트리 즉시 복원
  await git(cwd, ['stash', 'apply'])

  // 방금 만든 stash ref 조회
  const stashList = await git(cwd, ['stash', 'list', '--format=%gd %s'])
  const line = stashList.split('\n').find((l) => l.includes(label))
  const stashRef = line?.split(' ')[0]

  log.info('[CheckpointManager] 체크포인트 생성', { sessionId, headHash, stashRef })
  return { stashRef, headHash, sessionId, timestamp }
}

export interface CheckpointRestoreInfo {
  changedFiles: string[]
  shortHash: string
}

export async function restoreCheckpoint(cwd: string, checkpoint: Checkpoint): Promise<CheckpointRestoreInfo> {
  log.info('[CheckpointManager] 복원 시작', checkpoint)

  // 복원 전 stash에서 변경 파일 목록 획득
  let changedFiles: string[] = []
  if (checkpoint.stashRef) {
    try {
      const nameOnly = await git(cwd, ['stash', 'show', '--name-only', checkpoint.stashRef])
      changedFiles = nameOnly.split('\n').filter((f) => f.trim().length > 0)
    } catch {
      // stash가 이미 drop된 경우 등 — 빈 배열 유지
    }
  }

  // shortHash: stashRef에서 추출하거나 headHash 앞 7자리 사용
  const shortHash = checkpoint.headHash ? checkpoint.headHash.slice(0, 7) : (checkpoint.stashRef ?? 'unknown')

  // 현재 변경사항 제거
  await git(cwd, ['checkout', '.'])
  await git(cwd, ['clean', '-fd'])

  if (checkpoint.stashRef) {
    await git(cwd, ['stash', 'apply', checkpoint.stashRef])
  } else {
    // stash 없음 — HEAD로 되돌리기
    await git(cwd, ['checkout', checkpoint.headHash, '--', '.'])
  }

  log.info('[CheckpointManager] 복원 완료', { stashRef: checkpoint.stashRef, changedFiles: changedFiles.length })
  return { changedFiles, shortHash }
}

export async function listCheckpoints(cwd: string, sessionId?: string): Promise<Checkpoint[]> {
  let stashList: string
  try {
    stashList = await git(cwd, ['stash', 'list', '--format=%gd|%s|%ct'])
  } catch {
    return []
  }

  const results: Checkpoint[] = []
  for (const line of stashList.split('\n')) {
    if (!line.trim()) continue
    const [ref, subject, ctStr] = line.split('|')
    if (!subject?.includes('nexus-checkpoint-')) continue

    // subject 형식: On <branch>: nexus-checkpoint-{sessionId}-{timestamp}
    const match = subject.match(/nexus-checkpoint-([^-]+(?:-[^-]+)*)-(\d+)$/)
    if (!match) continue

    const sid = match[1]
    const ts = parseInt(match[2], 10)
    if (sessionId && sid !== sessionId) continue

    // HEAD 해시는 stash에서 직접 얻기 어려우므로 빈 문자열 처리
    results.push({ stashRef: ref, headHash: '', sessionId: sid, timestamp: ts || parseInt(ctStr ?? '0', 10) * 1000 })
  }

  return results
}
