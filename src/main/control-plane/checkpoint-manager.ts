import { execFile } from 'child_process'
import { promisify } from 'util'
import { logger } from '../logger'

const execFileAsync = promisify(execFile)

export interface Checkpoint {
  /** git stash create로 생성된 commit object hash. 빈 문자열이면 클린 트리 */
  hash: string
  headHash: string
  sessionId: string
  timestamp: number
  messageId?: string
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

export async function createCheckpoint(cwd: string, sessionId: string, messageId?: string): Promise<Checkpoint | null> {
  let headHash: string
  try {
    headHash = await git(cwd, ['rev-parse', 'HEAD'])
  } catch {
    // 커밋이 없는 repo (git init 직후) — 체크포인트 생성 불가
    logger.checkpoint.info('커밋 없는 repo, 체크포인트 스킵', { sessionId })
    return null
  }
  const timestamp = Date.now()

  // 변경사항 확인 (untracked 포함)
  const statusOut = await git(cwd, ['status', '--porcelain'])
  if (!statusOut) {
    // 클린 트리 — HEAD 해시만 기록, hash 빈 문자열
    logger.checkpoint.info('클린 트리, HEAD만 기록', { sessionId, headHash })
    return { hash: '', headHash, sessionId, timestamp, messageId }
  }

  // git stash create: working tree 변경 없이 commit object만 생성
  const hash = await git(cwd, ['stash', 'create'])

  logger.checkpoint.info('체크포인트 생성', { sessionId, headHash, hash })
  return { hash, headHash, sessionId, timestamp, messageId }
}

export interface CheckpointRestoreInfo {
  changedFiles: string[]
  shortHash: string
}

export async function restoreCheckpoint(cwd: string, checkpoint: Checkpoint): Promise<CheckpointRestoreInfo> {
  logger.checkpoint.info('복원 시작', { ...checkpoint })

  // 복원 전 stash에서 변경 파일 목록 획득
  let changedFiles: string[] = []
  if (checkpoint.hash) {
    try {
      const nameOnly = await git(cwd, ['diff', '--name-only', checkpoint.hash, 'HEAD'])
      changedFiles = nameOnly.split('\n').filter((f) => f.trim().length > 0)
      // stash에 포함된 파일도 확인
      const stashFiles = await git(cwd, ['show', '--name-only', '--format=', checkpoint.hash])
      const extra = stashFiles.split('\n').filter((f) => f.trim().length > 0)
      const merged = Array.from(new Set([...changedFiles, ...extra]))
      changedFiles = merged
    } catch {
      // 오류 시 빈 배열 유지
    }
  }

  // shortHash: hash에서 앞 7자리 또는 headHash 앞 7자리
  const shortHash = checkpoint.hash
    ? checkpoint.hash.slice(0, 7)
    : checkpoint.headHash.slice(0, 7)

  // 현재 변경사항 제거
  await git(cwd, ['checkout', '.'])
  await git(cwd, ['clean', '-fd'])

  if (checkpoint.hash) {
    await git(cwd, ['stash', 'apply', checkpoint.hash])
  } else {
    // 클린 트리였던 시점 — HEAD로 되돌리기 (이미 checkout . 으로 완료)
    await git(cwd, ['checkout', checkpoint.headHash, '--', '.'])
  }

  logger.checkpoint.info('복원 완료', { hash: checkpoint.hash, changedFiles: changedFiles.length, sessionId: checkpoint.sessionId })
  return { changedFiles, shortHash }
}
