import type { HarnessProtectionRules } from '../security/path-guard.js'

// ---------------------------------------------------------------------------
// Claude Code harness — protected path constants
// ---------------------------------------------------------------------------

export const CLAUDE_PROTECTED_DIR = '.claude'

export const CLAUDE_WHITELIST: readonly string[] = [
  '.claude/commands',
  '.claude/agents',
  '.claude/skills',
  '.claude/worktrees',
]

export const CLAUDE_PROTECTION_RULES: HarnessProtectionRules = {
  protectedDirs: [CLAUDE_PROTECTED_DIR],
  whitelist: CLAUDE_WHITELIST,
}
