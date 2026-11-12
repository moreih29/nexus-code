import { execFileSync } from "node:child_process";
import { isLinux, isMac, loginShell } from "./platform";

/**
 * A macOS GUI app is started by launchd, so it only gets the system default PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`). When launched from a terminal / iTerm / `bun run dev`,
 * the parent process already has the user's shell PATH and the child inherits it, but a
 * packaged app passes the thin PATH on as is to its children (PTY shell, ssh,
 * sftp, etc.). As a result, small frictions occur widely: `command not found` when `.zshrc` calls
 * `~/.local/bin/uv` or `/opt/homebrew/bin/...`, ssh failing to find the
 * ProxyCommand from the user's ssh_config, and so on.
 *
 * At boot it runs the user's login+interactive shell once, reads `$PATH`, and sets it in
 * `process.env.PATH`. Every later child_process / pty / ssh child
 * inherits this PATH.
 *
 * `-ilc`:
 * - `-l` login shell — loads `.zprofile` / `.bash_profile` / `.profile`
 * - `-i` interactive shell — loads `.zshrc` / `.bashrc`
 * - `-c` run a single command, then exit
 *
 * 5-second timeout: so boot is not delayed when the user's shell init is abnormally slow (e.g. an
 * rc file that depends on a remote mount). On timeout or failure it keeps the existing PATH
 * and carries on quietly (degrade gracefully).
 *
 * Called only when `app.isPackaged === true` and on darwin/linux. Dev mode already has
 * the parent shell PATH, so syncing is unnecessary (and it avoids a boot delay).
 */
export function syncUserShellPath(): void {
  if (!isMac() && !isLinux()) return;

  const shell = loginShell();
  try {
    // Use `printf %s "$PATH"` — it strips the trailing newline. Avoids echo, which can
    // behave differently between zsh and bash.
    const output = execFileSync(shell, ["-ilc", 'printf %s "$PATH"'], {
      encoding: "utf8",
      timeout: 5000,
      // Ignore stderr: messages such as `command not found` from inside `.zshrc`
      // do not affect the PATH output.
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = output.trim();
    if (trimmed.length > 0 && trimmed !== process.env.PATH) {
      process.env.PATH = trimmed;
    }
  } catch {
    // Timeout, shell launch failure, anything else — keep the default PATH.
  }
}
