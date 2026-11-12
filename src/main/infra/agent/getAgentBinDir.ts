import fs from "node:fs";
import path from "node:path";
import {
  type AgentArtifactPlatform,
  AgentManifestSchema,
  findAgentBinary,
} from "../../../shared/agent/manifest";
import { LOCAL_AGENT_DIST_DIR } from "./ssh/ssh-bootstrap/types";

/**
 * Gets Electron `app` by lazy require. The test environment (bun test) does not evaluate the electron
 * module, so a top-level import raises the error `Export named 'app' not found`.
 * Requiring only at call time means electron is not loaded unless test code goes
 * through this function.
 */
function getElectronApp(): typeof import("electron").app {
  const electron = require("electron") as typeof import("electron");
  return electron.app;
}

/**
 * Returns the absolute path of the agent distribution directory (dist/agent).
 *
 * - Packaged app: process.resourcesPath/agent
 * - Dev environment:   LOCAL_AGENT_DIST_DIR  (cwd/dist/agent)
 *
 * The `LOCAL_AGENT_DIST_DIR` constant is a dev default based on `process.cwd()`, so never use it
 * directly in a packaged app (where `process.cwd()` is usually `/`). Every consumer that needs
 * the branch must go through this function.
 */
export function getAgentDistDir(): string {
  return getElectronApp().isPackaged
    ? path.join(process.resourcesPath, "agent")
    : LOCAL_AGENT_DIST_DIR;
}

/**
 * Returns the absolute path of the bin/ directory, inside the agent distribution directory,
 * where the binaries (including the wrappers) live.
 *
 * - Packaged app: process.resourcesPath/agent/bin
 * - Dev environment:   LOCAL_AGENT_DIST_DIR/bin  (dist/agent/bin)
 */
export function getAgentBinDir(): string {
  return path.join(getAgentDistDir(), "bin");
}

/**
 * The manifest platform of this machine's agent build, or null when no build
 * targets it.
 */
export function localAgentPlatform(): AgentArtifactPlatform | null {
  const os =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "linux"
        ? "linux"
        : process.platform === "win32"
          ? "windows"
          : null;
  const arch = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : null;
  return os && arch ? { os, arch } : null;
}

/**
 * Returns the absolute path of the agent binary for the current platform.
 *
 * Finds the current os/arch entry in manifest.json to decide the path.
 * Returns undefined if the manifest cannot be parsed or has no entry for the current platform.
 *
 * - Packaged app: process.resourcesPath/agent/<name>
 * - Dev environment:   LOCAL_AGENT_DIST_DIR/<name>
 */
export function getAgentBinaryPath(): string | undefined {
  const distDir = getAgentDistDir();

  const manifestPath = path.join(distDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return undefined;

  try {
    const manifest = AgentManifestSchema.parse(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
    const platform = localAgentPlatform();
    if (!platform) return undefined;

    const entry = findAgentBinary(manifest, platform);
    if (!entry) return undefined;

    return path.join(distDir, entry.path);
  } catch {
    return undefined;
  }
}
