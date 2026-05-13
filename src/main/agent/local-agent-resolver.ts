import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { LOCAL_AGENT_DIST_DIR } from "./ssh-bootstrap";

const LocalBinarySchema = z.object({
  os: z.enum(["linux", "darwin"]),
  arch: z.enum(["amd64", "arm64"]),
  path: z.string(),
});

const LocalManifestSchema = z.object({
  binaries: z.array(LocalBinarySchema),
});

export interface LocalAgentCommand {
  readonly binaryPath: string;
  readonly argsPrefix?: readonly string[];
  readonly cwd?: string;
}

export function resolveLocalAgentCommand(distDir = LOCAL_AGENT_DIST_DIR): LocalAgentCommand {
  const manifestPath = path.join(distDir, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    const manifest = LocalManifestSchema.parse(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
    const platform = localPlatform();
    const binary = manifest.binaries.find(
      (candidate) => candidate.os === platform.os && candidate.arch === platform.arch,
    );
    if (binary) {
      return { binaryPath: path.resolve(distDir, binary.path) };
    }
  }

  return { binaryPath: "go", argsPrefix: ["run", "./cmd/agent"], cwd: process.cwd() };
}

function localPlatform(): { readonly os: "linux" | "darwin"; readonly arch: "amd64" | "arm64" } {
  const os =
    process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
  const arch = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : null;
  if (!os || !arch) {
    throw new Error(`unsupported local agent platform ${process.platform}-${process.arch}`);
  }
  return { os, arch };
}
