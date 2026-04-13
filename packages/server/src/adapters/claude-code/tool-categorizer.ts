// ---------------------------------------------------------------------------
// Claude Code tool name categorization
// ---------------------------------------------------------------------------

export type ToolCategory = 'read' | 'edit' | 'bash-fs' | 'bash-other' | 'web' | 'task' | 'mcp' | 'unknown'

export const CLAUDE_READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead'])
export const CLAUDE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
export const CLAUDE_WEB_TOOLS = new Set(['WebFetch', 'WebSearch'])

export function categorizeClaudeCodeTool(
  toolName: string,
  parseReason?: string,
  bashFsSubset?: boolean,
): ToolCategory {
  if (CLAUDE_READ_TOOLS.has(toolName)) return 'read'
  if (CLAUDE_EDIT_TOOLS.has(toolName)) return 'edit'
  if (CLAUDE_WEB_TOOLS.has(toolName)) return 'web'
  if (toolName === 'Task') return 'task'
  if (toolName === 'Bash') {
    if (parseReason) return 'bash-other' // 파싱 실패 → fail-closed
    if (bashFsSubset) return 'bash-fs'
    return 'bash-other'
  }
  if (toolName.startsWith('mcp__')) return 'mcp'
  return 'unknown'
}
