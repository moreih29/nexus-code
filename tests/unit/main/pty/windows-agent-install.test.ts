import { expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let root: string;
mock.module("../../../../src/main/infra/agent/runtimeDirs", () => ({
  root: () => root,
  binDir: () => path.join(root, "bin"),
  ensureDir: (dir: string) => fs.mkdir(dir, { recursive: true }),
}));
mock.module("../../../../src/main/infra/agent/getAgentBinDir", () => ({
  getAgentBinDir: () => root,
}));
const { installWindowsAgentFiles } = await import(
  "../../../../src/main/features/pty/windows-shell-shim"
);

test("retries a partial Windows wrapper installation and caches the complete one", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nx-windows-wrappers-"));
  const settings = path.join(root, "claude-settings.json");
  try {
    await fs.writeFile(path.join(root, "claude"), "cat <<'SETTINGS_EOF'\n{}\nSETTINGS_EOF\n");
    await fs.mkdir(settings);
    const partial = await installWindowsAgentFiles();
    expect(partial?.cmdLauncherDir).toBeDefined();
    expect(partial?.settingsPath).toBeUndefined();
    await fs.rmdir(settings);

    const a = installWindowsAgentFiles();
    const b = installWindowsAgentFiles();
    expect(a).toBe(b);
    expect((await a)?.settingsPath).toBe(settings);
    expect(await fs.readFile(settings, "utf8")).toBe("{}");
    expect(installWindowsAgentFiles()).toBe(a);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
