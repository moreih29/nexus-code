// ---------------------------------------------------------------------------
// Protected paths fixtures — isProtected(absPath, workspaceRoot)
// ---------------------------------------------------------------------------

export type ProtectedFixture = {
  desc: string
  /** Path relative to workspace root — used to compute abs path in tests */
  rel: string
  expected: boolean
}

export const protectedFixtures: ProtectedFixture[] = [
  // .git directory (PROTECTED_DIRS)
  { desc: '.git/config', rel: '.git/config', expected: true },

  // .env* files (ENV_FILE_REGEX)
  { desc: '.env bare', rel: '.env', expected: true },
  { desc: '.env.local', rel: '.env.local', expected: true },
  { desc: '.env.production.enc', rel: '.env.production.enc', expected: true },

  // PROTECTED_FILES exact entries
  { desc: '.claude.json (PROTECTED_FILES)', rel: '.claude.json', expected: true },

  // .claude/ with whitelist exceptions
  { desc: '.claude/commands — whitelisted', rel: '.claude/commands/foo.md', expected: false },
  { desc: '.claude/agents — whitelisted', rel: '.claude/agents/bar.yaml', expected: false },
  { desc: '.claude/skills — whitelisted', rel: '.claude/skills/my-skill.ts', expected: false },
  { desc: '.claude/worktrees — whitelisted', rel: '.claude/worktrees/main', expected: false },
  { desc: '.claude root itself', rel: '.claude', expected: true },
  { desc: '.claude/settings.local.json — not whitelisted', rel: '.claude/settings.local.json', expected: true },

  // .nexus/state (PROTECTED_DIRS)
  { desc: '.nexus/state/plan.json', rel: '.nexus/state/plan.json', expected: true },

  // .husky (PROTECTED_DIRS)
  { desc: '.husky/pre-commit', rel: '.husky/pre-commit', expected: true },

  // Paths outside workspace scope — not protected (out-of-scope)
  { desc: 'outside workspace (../sibling)', rel: '../sibling/file', expected: false },

  // Normal source files — not protected
  { desc: 'normal source file', rel: 'src/index.ts', expected: false },

  // Files that look like protected dirs but aren't (e.g. .vscode)
  { desc: '.vscode/settings.json — not in protected list', rel: '.vscode/settings.json', expected: false },
]
