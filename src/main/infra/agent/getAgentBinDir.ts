import fs from "node:fs";
import path from "node:path";
import {
  type AgentArtifactPlatform,
  AgentManifestSchema,
  findAgentBinary,
} from "../../../shared/agent/manifest";
import { LOCAL_AGENT_DIST_DIR } from "./ssh/ssh-bootstrap/types";

function getElectronApp(): typeof import("electron").app {
  const electron = require("electron") as typeof import("electron");
  return electron.app;
}

export function getAgentDistDir(): string {
  return getElectronApp().isPackaged
    ? path.join(process.resourcesPath, "agent")
    : LOCAL_AGENT_DIST_DIR;
}

export function getAgentBinDir(): string {
  return path.join(getAgentDistDir(), "bin");
}

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
