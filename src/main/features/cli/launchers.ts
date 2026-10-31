/**
 * The nexus command for local Windows terminals: nexus.exe, which cmd and
 * PowerShell run as a program, and for Git Bash a script that runs it. The
 * bash claude wrapper in dist/agent/bin is of no use to a Windows shell and
 * must not shadow the real claude, so Windows terminals get a directory of
 * their own, ~/.nexus-code/cli. Git Bash takes the wrapper's copy in
 * ~/.nexus-code/bin instead (pty/windows-shell-shim.ts), so its script is
 * written there too. nexus.exe is copied out of the app at runtime because a
 * shell may not run the files of an MSIX package.
 */
import fs from "node:fs";
import path from "node:path";
import { cliExecutableName, windowsGitBashLauncher } from "../../../shared/cli/launcher";
import { createLogger } from "../../../shared/log/main";
import { getAgentBinaryPath } from "../../infra/agent/getAgentBinDir";
import { binDir, root } from "../../infra/agent/runtimeDirs";

const log = createLogger("cli-launchers");

let written: string | null | undefined;

/** The suffix of a nexus.exe moved aside while it ran. */
const ASIDE = ".old";

/**
 * Puts `data` at `dest` unless it is there already. Windows refuses to
 * overwrite a program that is running, such as a `nexus terminal wait`, but
 * lets it be renamed: the running one is moved aside, and removed on a later
 * start once it has exited.
 */
function install(dest: string, data: Buffer): void {
  for (const name of fs.readdirSync(path.dirname(dest))) {
    if (!name.endsWith(ASIDE)) continue;
    try {
      fs.rmSync(path.join(path.dirname(dest), name), { force: true });
    } catch {
      // Still running; the next start removes it.
    }
  }
  try {
    if (fs.readFileSync(dest).equals(data)) return;
  } catch {
    // Not there yet.
  }
  try {
    fs.writeFileSync(dest, data);
  } catch {
    fs.renameSync(dest, `${dest}.${process.pid}-${Date.now()}${ASIDE}`);
    fs.writeFileSync(dest, data);
  }
}

/**
 * Puts the nexus command in `dir`, nexus.exe from beside `agent` and Git
 * Bash's script, and the script in `wrapperDir` too.
 */
export function writeWindowsCli(agent: string, dir: string, wrapperDir: string): void {
  const source = path.join(path.dirname(agent), cliExecutableName(path.basename(agent)));
  fs.mkdirSync(dir, { recursive: true });
  const program = path.join(dir, "nexus.exe");
  install(program, fs.readFileSync(source));
  // The launcher before nexus.exe, which handed its arguments to cmd.
  fs.rmSync(path.join(dir, "nexus.cmd"), { force: true });
  const script = windowsGitBashLauncher(program);
  fs.writeFileSync(path.join(dir, "nexus"), script);
  fs.mkdirSync(wrapperDir, { recursive: true });
  fs.writeFileSync(path.join(wrapperDir, "nexus"), script);
}

/**
 * The directory of the Windows nexus command, written on first use; null
 * when it cannot be.
 */
export function windowsCliLauncherDir(): string | null {
  if (written !== undefined) return written;
  try {
    const agent = getAgentBinaryPath();
    if (!agent) {
      written = null;
      return written;
    }
    const dir = path.join(root(), "cli");
    writeWindowsCli(agent, dir, binDir());
    written = dir;
  } catch (error) {
    log.warn(`writing the nexus command failed: ${(error as Error).message}`);
    written = null;
  }
  return written;
}
