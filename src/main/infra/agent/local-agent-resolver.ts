import fs from "node:fs";
import path from "node:path";
import { AgentManifestSchema, findAgentBinary } from "../../../shared/agent/manifest";
import { getAgentDistDir, localAgentPlatform } from "./getAgentBinDir";

export interface LocalAgentCommand {
  readonly binaryPath: string;
  readonly argsPrefix?: readonly string[];
  readonly cwd?: string;
}

export type LocalAgentResolutionMode = "auto" | "source" | "manifest";

export interface ResolveLocalAgentOptions {
  readonly distDir?: string;
  readonly mode?: LocalAgentResolutionMode;
  readonly env?: NodeJS.ProcessEnv;
}

export const NEXUS_AGENT_MODE_ENV = "NEXUS_AGENT_MODE";

export function resolveLocalAgentCommand(
  options: ResolveLocalAgentOptions = {},
): LocalAgentCommand {
  const mode = options.mode ?? "auto";
  const env = options.env ?? process.env;
  const distDir = options.distDir ?? getAgentDistDir();

  if (mode === "source") {
    return sourceCommand();
  }
  if (mode === "auto" && env[NEXUS_AGENT_MODE_ENV] === "source") {
    return sourceCommand();
  }

  const manifestPath = path.join(distDir, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = AgentManifestSchema.parse(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
      const platform = localAgentPlatform();
      if (!platform) {
        throw new Error(`unsupported local agent platform ${process.platform}-${process.arch}`);
      }
      const binary = findAgentBinary(manifest, platform);
      if (binary) {
        return { binaryPath: path.resolve(distDir, binary.path) };
      }
    } catch {}
  }

  return sourceCommand();
}

function sourceCommand(): LocalAgentCommand {
  return { binaryPath: "go", argsPrefix: ["run", "./cmd/agent"], cwd: process.cwd() };
}
