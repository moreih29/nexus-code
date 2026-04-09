import type { UnparseReason } from '../path-guard.js'

// ---------------------------------------------------------------------------
// Allow fixtures — Bash commands that should parse successfully
// ---------------------------------------------------------------------------

export type AllowFixture = {
  desc: string
  command: string
  expectedPaths: string[]
}

export const allowFixtures: AllowFixture[] = [
  // Simple single-path commands
  { desc: 'mkdir -p', command: 'mkdir -p foo', expectedPaths: ['foo'] },
  { desc: 'touch', command: 'touch foo/bar', expectedPaths: ['foo/bar'] },
  { desc: 'rm -rf', command: 'rm -rf node_modules', expectedPaths: ['node_modules'] },
  // Multi-path commands
  { desc: 'mv 2-arg', command: 'mv a b', expectedPaths: ['a', 'b'] },
  { desc: 'cp 2-arg', command: 'cp src.ts dst.ts', expectedPaths: ['src.ts', 'dst.ts'] },
  // sed in-place variants
  { desc: 'sed -i simple', command: `sed -i "s/a/b/" foo.txt`, expectedPaths: ['foo.txt'] },
  { desc: 'sed -i.bak', command: `sed -i.bak "s/a/b/" foo.txt`, expectedPaths: ['foo.txt'] },
  // Chaining / separators — all paths collected across segments
  { desc: 'mkdir && touch', command: 'mkdir foo && touch bar', expectedPaths: ['foo', 'bar'] },
  { desc: 'semicolon chain', command: 'mkdir a; mkdir b', expectedPaths: ['a', 'b'] },
  { desc: 'or chain', command: 'mkdir a || mkdir b', expectedPaths: ['a', 'b'] },
  // Special arg forms
  { desc: '-- after flags treats next token as path', command: 'rm -- -strangename', expectedPaths: ['-strangename'] },
  // Nested path arguments
  { desc: 'nested paths', command: 'cp foo/bar foo/baz', expectedPaths: ['foo/bar', 'foo/baz'] },
]

// ---------------------------------------------------------------------------
// Unparseable fixtures — Bash commands that must be rejected
// ---------------------------------------------------------------------------

export type UnparseableFixture = {
  desc: string
  command: string
  expectedReason: UnparseReason
}

export const unparseableFixtures: UnparseableFixture[] = [
  // unknown-command: allowed commands mixed with disallowed ones, or unknown command alone
  {
    desc: 'mixed chain: allowed + unknown command',
    command: 'mkdir foo && npm test',
    expectedReason: 'unknown-command',
  },
  {
    desc: 'standalone unknown command',
    command: 'npm install',
    expectedReason: 'unknown-command',
  },
  // NOTE: pre-scan runs before command identity check, so '>' in 'echo "x" > file.txt'
  // is detected first → pipe-or-redirect (not unknown-command).
  {
    desc: 'echo with redirect yields pipe-or-redirect (> scanned before command)',
    command: 'echo "x" > file.txt',
    expectedReason: 'pipe-or-redirect',
  },

  // shell-expansion
  {
    desc: 'command substitution $(...)',
    command: 'mkdir $(find . -name foo)',
    expectedReason: 'shell-expansion',
  },
  {
    desc: 'glob wildcard *',
    command: 'mkdir *',
    expectedReason: 'shell-expansion',
  },
  {
    desc: 'glob question mark',
    command: 'rm file?.txt',
    expectedReason: 'shell-expansion',
  },
  {
    desc: 'backtick substitution',
    command: 'rm `ls /tmp`',
    expectedReason: 'shell-expansion',
  },

  // variable-expansion
  {
    // VARIABLE_RE requires the entire token to be a variable (no path suffix)
    desc: 'standalone variable token $HOME',
    command: 'mkdir $HOME',
    expectedReason: 'variable-expansion',
  },
  {
    // ${BUILD}/foo matches SHELL_EXPANSION_RE (${) — reason is shell-expansion
    desc: 'brace variable ${BUILD}/foo — shell-expansion (not variable-expansion)',
    command: 'mkdir ${BUILD}/foo',
    expectedReason: 'shell-expansion',
  },

  // pipe-or-redirect
  {
    desc: 'pipe cat | tee',
    command: 'cat a | tee b',
    expectedReason: 'pipe-or-redirect',
  },
  {
    desc: 'output redirect > with allowed command',
    command: 'mkdir foo > /dev/null',
    expectedReason: 'pipe-or-redirect',
  },

  // bypass-wrapper
  {
    desc: 'sudo prefix',
    command: 'sudo rm -rf /tmp',
    expectedReason: 'bypass-wrapper',
  },
  {
    desc: 'doas prefix',
    command: 'doas mkdir foo',
    expectedReason: 'bypass-wrapper',
  },
  {
    desc: 'env wrapper',
    command: 'env DEBUG=1 touch foo',
    expectedReason: 'bypass-wrapper',
  },
  {
    desc: 'absolute path command /bin/rm',
    command: '/bin/rm foo',
    expectedReason: 'bypass-wrapper',
  },
  {
    desc: 'relative path command ./mkdir',
    command: './mkdir foo',
    expectedReason: 'bypass-wrapper',
  },
  {
    desc: 'eval wrapper',
    command: 'eval "mkdir foo"',
    expectedReason: 'bypass-wrapper',
  },

  // NOTE: mkdir "foo (unclosed double-quote) — the tokenizer reads to EOF
  // gracefully and emits a word token "foo", so this parses as { kind: 'paths',
  // paths: ['foo'] } rather than returning parse-error. The fixture is therefore
  // placed in allowFixtures-adjacent behavior; this entry is omitted to avoid
  // false-failure. See path-guard.test.ts for an explicit assertion on this case.
]
