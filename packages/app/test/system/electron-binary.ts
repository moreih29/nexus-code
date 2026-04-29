import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

export function resolveElectronBinary(): string {
  const packageJsonPath = require.resolve("electron/package.json");
  const packageDir = dirname(packageJsonPath);
  const executablePath = readFileSync(join(packageDir, "path.txt"), "utf8").trim();

  if (process.env.ELECTRON_OVERRIDE_DIST_PATH) {
    return join(process.env.ELECTRON_OVERRIDE_DIST_PATH, executablePath || "electron");
  }

  if (!executablePath) {
    throw new Error("Electron executable path.txt is empty.");
  }

  return join(packageDir, "dist", executablePath);
}
