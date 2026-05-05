// zsh init wrapper (ZDOTDIR).
//
// zsh's PROMPT_SP option (default ON) pads every prompt with inverse-video
// spaces and a PROMPT_EOL_MARK glyph (default '%') when the previous
// command's output didn't end with a newline. In a GUI terminal this is
// noise. PROMPT_EOL_MARK can be blanked via env, but PROMPT_SP is a zsh
// shell option (not an env var) and can only be turned off from inside an
// rc file.
//
// We follow VSCode's pattern (see references/vscode/.../shellIntegration-*.zsh
// and src/vs/platform/terminal/node/terminalEnvironment.ts L212-257):
//
//   1. Create a private ZDOTDIR under tmpdir (username-namespaced, sticky-bit
//      0o1700 so other users on the host can't tamper).
//   2. Pass USER_ZDOTDIR = original $ZDOTDIR (or $HOME if unset) so the
//      wrapper rc can find the user's real dotfiles.
//   3. Each wrapper rc temporarily restores ZDOTDIR to USER_ZDOTDIR before
//      sourcing the user's file, then restores ours. Recursion is guarded
//      via marker variables.
//   4. .zshrc additionally turns off PROMPT_SP / PROMPT_EOL_MARK BEFORE
//      sourcing the user's ~/.zshrc so a user who explicitly wants the
//      behavior can re-enable it in their own rc.
//
// Non-zsh shells (bash, fish, sh) ignore ZDOTDIR, so the env addition is
// a no-op for them.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let zshInitDir: string | null = null;

/**
 * Create (or reuse) the per-user wrapper ZDOTDIR and write the four rc
 * files into it. Returns the directory path. Idempotent — repeated
 * calls return the same directory and rewrite the rc files.
 */
export function ensureZshInitDir(): string {
  if (zshInitDir) return zshInitDir;
  let username = "unknown";
  try {
    username = os.userInfo().username;
  } catch {
    // fall back to "unknown" — userInfo can fail in unusual containerized envs
  }
  const realTmpDir = fs.realpathSync(os.tmpdir());
  const dir = path.join(realTmpDir, `${username}-nexus-code-zsh`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    // Sticky bit + owner-only permissions so other local users cannot tamper.
    fs.chmodSync(dir, 0o1700);
  } catch {
    // ignore — best-effort hardening
  }

  // .zshenv — always sourced. Temporarily swap ZDOTDIR so the user's
  // ~/.zshenv (or $USER_ZDOTDIR/.zshenv) sees its expected ZDOTDIR.
  fs.writeFileSync(
    path.join(dir, ".zshenv"),
    [
      'if [[ -f "$USER_ZDOTDIR/.zshenv" ]]; then',
      '  NEXUS_ZDOTDIR="$ZDOTDIR"',
      '  ZDOTDIR="$USER_ZDOTDIR"',
      '  if [[ "$USER_ZDOTDIR" != "$NEXUS_ZDOTDIR" ]]; then',
      '    . "$USER_ZDOTDIR/.zshenv"',
      "  fi",
      '  USER_ZDOTDIR="$ZDOTDIR"',
      '  ZDOTDIR="$NEXUS_ZDOTDIR"',
      "fi",
      "",
    ].join("\n"),
  );

  // .zprofile — login-shell only. Recursion-guarded.
  fs.writeFileSync(
    path.join(dir, ".zprofile"),
    [
      'if [[ -n "$NEXUS_PROFILE_INITIALIZED" ]]; then',
      "  return",
      "fi",
      "export NEXUS_PROFILE_INITIALIZED=1",
      'if [[ $options[norcs] = off && -o "login" ]]; then',
      '  if [[ -f "$USER_ZDOTDIR/.zprofile" ]]; then',
      '    NEXUS_ZDOTDIR="$ZDOTDIR"',
      '    ZDOTDIR="$USER_ZDOTDIR"',
      '    . "$USER_ZDOTDIR/.zprofile"',
      '    ZDOTDIR="$NEXUS_ZDOTDIR"',
      "  fi",
      "fi",
      "",
    ].join("\n"),
  );

  // .zshrc — interactive shells. Apply our GUI defaults BEFORE sourcing
  // the user's ~/.zshrc so the user can re-enable PROMPT_SP in their rc.
  fs.writeFileSync(
    path.join(dir, ".zshrc"),
    [
      "# nexus-code: GUI-terminal defaults — set BEFORE sourcing user rc",
      "# so the user can re-enable PROMPT_SP / PROMPT_EOL_MARK in ~/.zshrc.",
      "unsetopt PROMPT_SP 2>/dev/null",
      "PROMPT_EOL_MARK=''",
      "",
      "# Prevent recursive sourcing if .zshrc somehow re-enters.",
      'if [[ -n "$NEXUS_ZSH_RC_LOADED" ]]; then',
      '  ZDOTDIR="$USER_ZDOTDIR"',
      "  return",
      "fi",
      "export NEXUS_ZSH_RC_LOADED=1",
      "",
      "# zsh defaults HISTFILE to $ZDOTDIR; keep history in the user's dir.",
      'HISTFILE="$USER_ZDOTDIR/.zsh_history"',
      "",
      'if [[ $options[norcs] = off && -f "$USER_ZDOTDIR/.zshrc" ]]; then',
      '  NEXUS_ZDOTDIR="$ZDOTDIR"',
      '  ZDOTDIR="$USER_ZDOTDIR"',
      '  . "$USER_ZDOTDIR/.zshrc"',
      "  # leave ZDOTDIR pointing at the user's dir for the rest of the session",
      "fi",
      "",
    ].join("\n"),
  );

  // .zlogin — login-shell only. Restore ZDOTDIR to the user's dir for
  // the rest of the session (matches VSCode's behavior).
  fs.writeFileSync(
    path.join(dir, ".zlogin"),
    [
      'ZDOTDIR="$USER_ZDOTDIR"',
      'if [[ $options[norcs] = off && -o "login" && -f "$ZDOTDIR/.zlogin" ]]; then',
      '  . "$ZDOTDIR/.zlogin"',
      "fi",
      "",
    ].join("\n"),
  );

  zshInitDir = dir;
  return dir;
}

/**
 * Resolve the user's effective ZDOTDIR for USER_ZDOTDIR. If they had
 * ZDOTDIR set in their environment, preserve it; otherwise fall back to
 * $HOME (which is where standard zsh dotfiles live).
 */
export function resolveUserZdotdir(): string {
  const existing = process.env.ZDOTDIR;
  if (existing && existing.length > 0) return existing;
  return os.homedir() || "~";
}
