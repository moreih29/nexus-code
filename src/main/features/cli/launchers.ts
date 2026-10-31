/**
 * The nexus command for local Windows terminals. The bash claude wrapper in
 * dist/agent/bin is of no use to a Windows shell and must not shadow the
 * real claude, so Windows terminals get a directory of their own holding
 * only the nexus launchers. They are written at runtime because they name
 * the agent by its full path — through the package's alias when the app
 * runs from an MSIX package, whose files a shell may not run itself.
 */
import fs from "node:fs";
import path from "node:path";
import { windowsCliLaunchers } from "../../../shared/cli/launcher";
import { createLogger } from "../../../shared/log/main";
import { getAgentBinaryPath } from "../../infra/agent/getAgentBinDir";
import { root } from "../../infra/agent/runtimeDirs";
import { agentAliasPath } from "../git/domain/helpers/launcher";

const log = createLogger("cli-launchers");

let written: string | null | undefined;

/** The agent command a Windows shell can run: the package alias, or the agent. */
function windowsAgentCommand(): string | null {
  const localAppData = process.env.LOCALAPPDATA;
  if (process.windowsStore && localAppData) {
    const alias = agentAliasPath(process.execPath, localAppData);
    if (alias) return alias;
  }
  return getAgentBinaryPath() ?? null;
}

/**
 * The directory of the Windows nexus launchers, written on first use; null
 * when they cannot be.
 */
export function windowsCliLauncherDir(): string | null {
  if (written !== undefined) return written;
  try {
    const command = windowsAgentCommand();
    if (!command) {
      written = null;
      return written;
    }
    const dir = path.join(root(), "cli");
    const launchers = windowsCliLaunchers(command);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "nexus.cmd"), launchers.cmd);
    fs.writeFileSync(path.join(dir, "nexus"), launchers.sh);
    written = dir;
  } catch (error) {
    log.warn(`writing the nexus launchers failed: ${(error as Error).message}`);
    written = null;
  }
  return written;
}
