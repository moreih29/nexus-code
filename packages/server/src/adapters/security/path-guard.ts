import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// ---------------------------------------------------------------------------
// HarnessProtectionRules
// ---------------------------------------------------------------------------

/**
 * Harness-specific protection rules composed into `isProtected` via the
 * optional `extraRules` parameter.  Each harness (Claude Code, OpenCode, …)
 * owns its own `HarnessProtectionRules` constant; the neutral path-guard
 * applies them without hardcoding any harness-specific directory names.
 */
export interface HarnessProtectionRules {
  /** Directories the harness considers protected (e.g. ['.claude']). */
  readonly protectedDirs: readonly string[]
  /**
   * Relative path prefixes that are whitelisted within those directories
   * (e.g. ['.claude/commands', '.claude/agents']).
   */
  readonly whitelist: readonly string[]
}

// ---------------------------------------------------------------------------
// Protected list constants
// ---------------------------------------------------------------------------

export const PROTECTED_DIRS = [
  '.git',
  '.husky',
  '.nexus/state',
] as const

export const PROTECTED_FILES = [
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.mcp.json',
  '.claude.json',
] as const

// Matches '.env' or '.env.<anything>'
const ENV_FILE_REGEX = /^\.env(\..+)?$/

// ---------------------------------------------------------------------------
// normalizePath
// ---------------------------------------------------------------------------

/**
 * Resolve `input` to an absolute, real path relative to `cwd`.
 *
 * - Expands leading `~` to the home directory.
 * - Resolves to absolute path via `path.resolve(cwd, input)`.
 * - Follows symlinks via `fs.realpath` when the path exists.
 * - When ENOENT: resolves the parent directory via realpath and re-attaches
 *   the basename (handles write targets that do not yet exist).
 * - When the parent also does not exist: returns the raw resolved path.
 */
export async function normalizePath(input: string, cwd: string): Promise<string> {
  const expanded = input.startsWith('~')
    ? path.join(os.homedir(), input.slice(1))
    : input

  const absPath = path.resolve(cwd, expanded)

  try {
    return await fs.promises.realpath(absPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err

    // Target does not exist — resolve the parent directory instead
    const dir = path.dirname(absPath)
    const base = path.basename(absPath)
    try {
      const realDir = await fs.promises.realpath(dir)
      return path.join(realDir, base)
    } catch {
      // Parent also missing — return raw resolved path
      return absPath
    }
  }
}

// ---------------------------------------------------------------------------
// isProtected
// ---------------------------------------------------------------------------

/**
 * Returns true when `absPath` is a protected location inside `workspaceRoot`.
 *
 * Only paths **inside** the workspace are guarded; anything outside is
 * considered out-of-scope and returns false.
 *
 * `extraRules` lets callers inject harness-specific protection rules (e.g.
 * Claude Code's `.claude` directory rules) without hardcoding them here.
 * When omitted, only the neutral common rules apply.
 */
export function isProtected(
  absPath: string,
  workspaceRoot: string,
  extraRules?: HarnessProtectionRules,
): boolean {
  const rel = path.relative(workspaceRoot, absPath)

  // Outside workspace or absolute — not our concern
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return false
  }

  // Normalize separators for consistent comparison
  const relNorm = rel.split(path.sep).join('/')

  // Harness-specific directory rules (extraRules)
  if (extraRules !== undefined) {
    for (const dir of extraRules.protectedDirs) {
      if (relNorm === dir || relNorm.startsWith(dir + '/')) {
        // Within a harness-protected dir — check whitelist
        const whitelisted = extraRules.whitelist.some(
          (w) => relNorm === w || relNorm.startsWith(w + '/'),
        )
        return !whitelisted
      }
    }
  }

  // .env* file check (basename only)
  const base = path.basename(absPath)
  if (ENV_FILE_REGEX.test(base)) {
    return true
  }

  // Protected directories
  const protectedDirMatch = (PROTECTED_DIRS as readonly string[]).some(
    (d) => relNorm === d || relNorm.startsWith(d + '/'),
  )
  if (protectedDirMatch) return true

  // Protected files (exact rel match or exact basename match)
  const protectedFileMatch = (PROTECTED_FILES as readonly string[]).some(
    (f) => relNorm === f || base === f,
  )
  if (protectedFileMatch) return true

  return false
}

// ---------------------------------------------------------------------------
// isWithinAllowedRoots
// ---------------------------------------------------------------------------

/**
 * Returns true when `absPath` is inside at least one of the given `roots`.
 */
export function isWithinAllowedRoots(absPath: string, roots: string[]): boolean {
  return roots.some((root) => {
    const rel = path.relative(root, absPath)
    return !rel.startsWith('..') && !path.isAbsolute(rel)
  })
}

// ---------------------------------------------------------------------------
// ExtractPathsResult types
// ---------------------------------------------------------------------------

export type UnparseReason =
  | 'chaining-mixed'
  | 'shell-expansion'
  | 'variable-expansion'
  | 'pipe-or-redirect'
  | 'bypass-wrapper'
  | 'unknown-command'
  | 'parse-error'

export type ExtractPathsResult =
  | { kind: 'paths'; paths: string[] }
  | { kind: 'unparseable'; reason: UnparseReason }
  | { kind: 'empty' }

// ---------------------------------------------------------------------------
// extractPaths
// ---------------------------------------------------------------------------

/**
 * Extracts filesystem paths that a tool call would write/modify.
 *
 * Returns `empty` for read-only tools (no guard needed).
 * Returns `paths` for write tools with successfully parsed targets.
 * Returns `unparseable` when the intent cannot be determined safely.
 */
export function extractPaths(toolName: string, toolInput: unknown): ExtractPathsResult {
  switch (toolName) {
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const input = toolInput as Record<string, unknown>
      if (typeof input?.file_path === 'string') {
        return { kind: 'paths', paths: [input.file_path] }
      }
      return { kind: 'unparseable', reason: 'parse-error' }
    }

    case 'Read':
    case 'Grep':
    case 'Glob':
    case 'NotebookRead':
      return { kind: 'empty' }

    case 'Bash': {
      const input = toolInput as Record<string, unknown>
      if (typeof input?.command === 'string') {
        return parseBashCommand(input.command)
      }
      return { kind: 'unparseable', reason: 'parse-error' }
    }

    default:
      return { kind: 'empty' }
  }
}

// ---------------------------------------------------------------------------
// Bash micro-parser internals
// ---------------------------------------------------------------------------

type Token = { type: 'word'; value: string } | { type: 'sep'; value: string }

/**
 * Tokenize a bash command string into words and separators.
 *
 * Handles:
 * - Single-quoted strings (no escapes inside)
 * - Double-quoted strings (backslash escapes inside)
 * - Backslash escapes outside quotes
 * - `&&`, `||`, `;` as separator tokens
 */
function tokenize(command: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const len = command.length

  while (i < len) {
    // Skip whitespace
    if (/\s/.test(command[i])) {
      i++
      continue
    }

    // Two-char separators first
    if (i + 1 < len && (command.slice(i, i + 2) === '&&' || command.slice(i, i + 2) === '||')) {
      tokens.push({ type: 'sep', value: command.slice(i, i + 2) })
      i += 2
      continue
    }

    if (command[i] === ';') {
      tokens.push({ type: 'sep', value: ';' })
      i++
      continue
    }

    // Accumulate a word token
    let word = ''

    while (i < len && !/\s/.test(command[i])) {
      const ch = command[i]

      if (ch === ';') break
      if (i + 1 < len && (command.slice(i, i + 2) === '&&' || command.slice(i, i + 2) === '||')) break

      if (ch === "'") {
        // Single-quoted: no escapes
        i++
        while (i < len && command[i] !== "'") {
          word += command[i++]
        }
        if (i < len) i++ // closing quote
      } else if (ch === '"') {
        // Double-quoted: backslash escapes
        i++
        while (i < len && command[i] !== '"') {
          if (command[i] === '\\' && i + 1 < len) {
            i++
            word += command[i++]
          } else {
            word += command[i++]
          }
        }
        if (i < len) i++ // closing quote
      } else if (ch === '\\') {
        // Backslash escape outside quotes
        if (i + 1 < len) {
          i++
          word += command[i++]
        } else {
          i++
        }
      } else {
        word += ch
        i++
      }
    }

    if (word.length > 0) {
      tokens.push({ type: 'word', value: word })
    }
  }

  return tokens
}

// Patterns that indicate shell features we cannot safely parse
const SHELL_EXPANSION_RE = /\$\(|`|\$\{|<\(|>\(/
const VARIABLE_RE = /^\$[A-Za-z_][A-Za-z0-9_]*$|^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/
const GLOB_CHARS_RE = /[*?[]/
const REDIRECT_TOKENS = new Set(['|', '>', '>>', '<', '<<', '2>', '&>'])

const ALLOWED_COMMANDS = new Set(['mkdir', 'touch', 'rm', 'rmdir', 'mv', 'cp', 'sed'])

const BYPASS_WRAPPERS = new Set([
  'sudo', 'env', 'exec', 'eval', 'source', '.', 'doas', 'su',
])

/**
 * Parse a bash command string and extract filesystem paths that would be
 * written/modified.
 *
 * fail-closed: any ambiguity or unsupported construct returns `unparseable`.
 */
export function parseBashCommand(command: string): ExtractPathsResult {
  let tokens: Token[]
  try {
    tokens = tokenize(command)
  } catch {
    return { kind: 'unparseable', reason: 'parse-error' }
  }

  // Pre-scan all word tokens for unsafe shell constructs
  for (const tok of tokens) {
    if (tok.type !== 'word') continue
    const v = tok.value

    if (SHELL_EXPANSION_RE.test(v)) {
      return { kind: 'unparseable', reason: 'shell-expansion' }
    }
    if (VARIABLE_RE.test(v)) {
      return { kind: 'unparseable', reason: 'variable-expansion' }
    }
    if (GLOB_CHARS_RE.test(v)) {
      return { kind: 'unparseable', reason: 'shell-expansion' }
    }
    if (REDIRECT_TOKENS.has(v)) {
      return { kind: 'unparseable', reason: 'pipe-or-redirect' }
    }
  }

  // Split into segments by separators
  const segments: string[][] = []
  let current: string[] = []

  for (const tok of tokens) {
    if (tok.type === 'sep') {
      if (current.length > 0) {
        segments.push(current)
        current = []
      }
    } else {
      current.push(tok.value)
    }
  }
  if (current.length > 0) segments.push(current)

  if (segments.length === 0) {
    return { kind: 'empty' }
  }

  // Parse each segment
  const allPaths: string[] = []

  for (const seg of segments) {
    if (seg.length === 0) continue

    const cmd = seg[0]
    const args = seg.slice(1)

    // Reject bypass wrappers and path-prefixed commands
    if (BYPASS_WRAPPERS.has(cmd)) {
      return { kind: 'unparseable', reason: 'bypass-wrapper' }
    }
    if (cmd.includes('/')) {
      return { kind: 'unparseable', reason: 'bypass-wrapper' }
    }

    if (!ALLOWED_COMMANDS.has(cmd)) {
      return { kind: 'unparseable', reason: 'unknown-command' }
    }

    let segPaths: string[]
    if (cmd === 'sed') {
      const result = parseSedArgs(args)
      if (result === null) {
        return { kind: 'unparseable', reason: 'unknown-command' }
      }
      segPaths = result
    } else {
      segPaths = parseDefaultArgs(args)
    }

    allPaths.push(...segPaths)
  }

  if (allPaths.length === 0) {
    return { kind: 'empty' }
  }

  return { kind: 'paths', paths: allPaths }
}

/**
 * Parse arguments for commands other than `sed`.
 *
 * - Tokens starting with `-` are flags (skipped).
 * - `--` ends flag parsing; all subsequent tokens are paths.
 * - Other tokens are path candidates.
 */
function parseDefaultArgs(args: string[]): string[] {
  const paths: string[] = []
  let endOfFlags = false

  for (const arg of args) {
    if (endOfFlags) {
      paths.push(arg)
    } else if (arg === '--') {
      endOfFlags = true
    } else if (arg.startsWith('-')) {
      // flag — skip
    } else {
      paths.push(arg)
    }
  }

  return paths
}

/**
 * Parse sed arguments and extract the file path(s) being edited in-place.
 *
 * Only recognizes the write-capable form: `sed -i[suffix] ... file`.
 * Without `-i`, sed is read-only (no paths returned → caller treats as
 * unknown-command / empty).
 *
 * Returns `null` when the form is unsupported (caller should return
 * `unparseable` with reason `unknown-command`).
 *
 * Handles:
 * - `-i` or `-i<suffix>` (in-place flag)
 * - `-e <script>` and `-f <scriptfile>` (consume next token as value)
 * - Remaining non-flag tokens: first is the script (if no `-e`/`-f` given),
 *   rest are file paths.
 *
 * Practical simplification: extract the **last** non-flag token as the file
 * path, which covers the common `sed -i 's/a/b/' file.txt` form.
 */
export function parseSedArgs(args: string[]): string[] | null {
  let hasInPlace = false
  const nonFlagTokens: string[] = []
  let i = 0

  while (i < args.length) {
    const arg = args[i]

    if (arg === '-i' || arg.startsWith('-i')) {
      // -i or -i<suffix>
      hasInPlace = true
      i++
    } else if (arg === '-e') {
      // consume next token as script expression
      i += 2 // skip -e and its value
    } else if (arg === '-f') {
      // consume next token as script file (not a write target)
      i += 2
    } else if (arg === '-n') {
      // read-only mode flag
      i++
    } else if (arg === '--') {
      // end of flags — all remaining are file paths
      i++
      while (i < args.length) {
        nonFlagTokens.push(args[i++])
      }
    } else if (arg.startsWith('-')) {
      // Unknown flag — skip (conservative)
      i++
    } else {
      nonFlagTokens.push(arg)
      i++
    }
  }

  if (!hasInPlace) {
    // sed without -i is read-only — not a write operation
    return null
  }

  if (nonFlagTokens.length === 0) {
    // -i given but no file argument
    return null
  }

  if (nonFlagTokens.length === 1) {
    // Could be `sed -i -e 's/a/b/' file` → only token is the file
    return [nonFlagTokens[0]]
  }

  // Multiple non-flag tokens: first is the inline script, rest are files
  // e.g. `sed -i 's/a/b/' file1.txt file2.txt`
  return nonFlagTokens.slice(1)
}
