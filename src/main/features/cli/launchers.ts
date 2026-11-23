import fs from "node:fs";
import path from "node:path";
import { cliExecutableName, windowsGitBashLauncher } from "../../../shared/cli/launcher";
import { createLogger } from "../../../shared/log/main";
import { redactLogSecrets } from "../../../shared/log/redact-secrets";
import { getAgentBinaryPath } from "../../infra/agent/getAgentBinDir";
import { binDir, root } from "../../infra/agent/runtimeDirs";

const log = createLogger("cli-launchers");

let written: string | null | undefined;

const ASIDE = ".old";

function install(dest: string, data: Buffer): void {
  for (const name of fs.readdirSync(path.dirname(dest))) {
    if (!name.endsWith(ASIDE)) continue;
    try {
      fs.rmSync(path.join(path.dirname(dest), name), { force: true });
    } catch {}
  }
  try {
    if (fs.readFileSync(dest).equals(data)) return;
  } catch {}
  try {
    fs.writeFileSync(dest, data);
  } catch {
    fs.renameSync(dest, `${dest}.${process.pid}-${Date.now()}${ASIDE}`);
    fs.writeFileSync(dest, data);
  }
}

export function writeWindowsCli(agent: string, dir: string, wrapperDir: string): void {
  const source = path.join(path.dirname(agent), cliExecutableName(path.basename(agent)));
  const data = fs.readFileSync(source);
  fs.mkdirSync(dir, { recursive: true });
  const program = path.join(dir, "nexus.exe");
  install(program, data);
  fs.rmSync(path.join(dir, "nexus.cmd"), { force: true });
  const script = windowsGitBashLauncher(program);
  fs.writeFileSync(path.join(dir, "nexus"), script);
  fs.mkdirSync(wrapperDir, { recursive: true });
  fs.writeFileSync(path.join(wrapperDir, "nexus"), script);
  install(path.join(wrapperDir, "nexus.exe"), data);
}

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
    log.warn(
      `writing the nexus command failed: ${redactLogSecrets(error instanceof Error ? error.message : String(error))}`,
    );
    written = null;
  }
  return written;
}
