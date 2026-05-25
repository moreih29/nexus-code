import fs from "node:fs";
import path from "node:path";
import { AgentManifestSchema, findAgentBinary } from "../../../shared/agent/manifest";
import { getAgentDistDir } from "./getAgentBinDir";

export interface LocalAgentCommand {
  readonly binaryPath: string;
  readonly argsPrefix?: readonly string[];
  readonly cwd?: string;
}

/**
 * Resolution mode for the local agent command.
 *
 * - `auto` (default): consult `NEXUS_AGENT_MODE`; otherwise use the manifest
 *   binary when present and fall back to `go run` when it is not.
 * - `source`: always run from source via `go run ./cmd/agent`. Used in dev so
 *   a stale `dist/agent` cannot silently route requests to an outdated
 *   dispatcher; also serves as an escape hatch for packaged debugging.
 * - `manifest`: always consult the manifest; fall back to `go run` only when
 *   the manifest cannot be parsed (preserves legacy behavior for callers
 *   that intentionally pin to dist output).
 */
export type LocalAgentResolutionMode = "auto" | "source" | "manifest";

export interface ResolveLocalAgentOptions {
  /** Override the dist directory used for manifest lookup. Test injection. */
  readonly distDir?: string;
  /** Force a specific resolution mode. Defaults to `auto`. */
  readonly mode?: LocalAgentResolutionMode;
  /** Override the environment map used to read NEXUS_AGENT_MODE. Test injection. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Environment variable that overrides resolution when `mode` is `auto`. Setting
 * it to `source` forces `go run`, which is what `src/main/index.ts` does when
 * Electron reports `!app.isPackaged` so dev runs never consume a stale
 * `dist/agent` artifact.
 */
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
      const platform = localPlatform();
      const binary = findAgentBinary(manifest, platform);
      if (binary) {
        return { binaryPath: path.resolve(distDir, binary.path) };
      }
    } catch {
      // Old dist manifests do not include the runtime/LSP sections. Fall through to go run.
    }
  }

  return sourceCommand();
}

/**
 * Returns the command shape that runs the agent from Go sources. Used in dev
 * and as the fallback when no usable manifest is on disk. `cwd` is pinned to
 * the current process working directory so `go run ./cmd/agent` resolves
 * against the repository module root (electron-vite dev preserves the repo
 * root as cwd).
 */
function sourceCommand(): LocalAgentCommand {
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
