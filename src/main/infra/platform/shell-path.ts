import { execFileSync } from "node:child_process";
import { isLinux, isMac, loginShell } from "./";

export function syncUserShellPath(): void {
  if (!isMac() && !isLinux()) return;

  const shell = loginShell();
  try {
    const output = execFileSync(shell, ["-ilc", 'printf %s "$PATH"'], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = output.trim();
    if (trimmed.length > 0 && trimmed !== process.env.PATH) {
      process.env.PATH = trimmed;
    }
  } catch {}
}
