/**
 * workspacePathToId: 워크스페이스 절대 경로를 로그 디렉토리명용 식별자로 변환.
 * Claude Code의 ~/.claude/projects/{id}/ 와 동일한 변환 규칙 사용 (슬래시 → 대시).
 * history-parser.ts의 getSessionFilePath와 동일 출력이 보장되어야 함.
 */
export function workspacePathToId(workspacePath: string): string {
  return workspacePath.replace(/\//g, '-')
}
