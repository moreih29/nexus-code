import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  NEXUS_AGENT_MODE_ENV,
  resolveLocalAgentCommand,
} from "../../../../src/main/infra/agent/local-agent-resolver";

/**
 * These tests exercise the mode gate that protects dev runs from stale
 * `dist/agent` binaries. They do not assert manifest-side details that are
 * already covered by the production schema; they assert only the routing
 * decisions resolveLocalAgentCommand makes from its inputs.
 */

function writeManifest(dir: string): void {
  const platform = `${process.platform === "darwin" ? "darwin" : "linux"}-${
    process.arch === "arm64" ? "arm64" : "amd64"
  }`;
  const [manifestOs, manifestArch] = platform.split("-") as [
    "linux" | "darwin",
    "amd64" | "arm64",
  ];
  // Minimum-viable manifest that AgentManifestSchema will accept. The binary
  // contents do not matter — the resolver only resolves the path.
  const binaryName = `agent-0.1.0-${manifestOs}-${manifestArch}`;
  fs.writeFileSync(path.join(dir, binaryName), "x");
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      version: "0.1.0",
      protocolVersion: "1",
      binaries: [
        {
          os: manifestOs,
          arch: manifestArch,
          path: binaryName,
          // SHA-256 of "x"
          sha256: "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
          size: 1,
        },
      ],
      // AgentManifestSchema requires at least one node runtime entry. The
      // resolver does not read it; the entry exists only so JSON.parse +
      // schema validation succeed and the manifest branch is exercised.
      runtime: {
        node: [
          {
            os: manifestOs,
            arch: manifestArch,
            version: "v20.19.0",
            path: "runtime/node.tar.gz",
            sha256: "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
            size: 1,
            entry: "bin/node",
          },
        ],
      },
      lspBinaries: [],
    }),
  );
}

describe("resolveLocalAgentCommand", () => {
  let tmpDir: string;
  let originalMode: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-agent-resolver-"));
    originalMode = process.env[NEXUS_AGENT_MODE_ENV];
    delete process.env[NEXUS_AGENT_MODE_ENV];
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalMode === undefined) {
      delete process.env[NEXUS_AGENT_MODE_ENV];
    } else {
      process.env[NEXUS_AGENT_MODE_ENV] = originalMode;
    }
  });

  test("mode=source forces go run even when a manifest is present", () => {
    writeManifest(tmpDir);
    const command = resolveLocalAgentCommand({ mode: "source", distDir: tmpDir });
    expect(command.binaryPath).toBe("go");
    expect(command.argsPrefix).toEqual(["run", "./cmd/agent"]);
  });

  test("mode=auto with NEXUS_AGENT_MODE=source bypasses the manifest", () => {
    writeManifest(tmpDir);
    const command = resolveLocalAgentCommand({
      mode: "auto",
      distDir: tmpDir,
      env: { [NEXUS_AGENT_MODE_ENV]: "source" },
    });
    expect(command.binaryPath).toBe("go");
    expect(command.argsPrefix).toEqual(["run", "./cmd/agent"]);
  });

  test("mode=auto with no env override prefers the manifest binary", () => {
    writeManifest(tmpDir);
    const command = resolveLocalAgentCommand({ mode: "auto", distDir: tmpDir, env: {} });
    expect(command.binaryPath).toMatch(/agent-0\.1\.0-/);
    expect(command.argsPrefix).toBeUndefined();
  });

  test("mode=auto with no manifest falls back to go run", () => {
    const command = resolveLocalAgentCommand({ mode: "auto", distDir: tmpDir, env: {} });
    expect(command.binaryPath).toBe("go");
    expect(command.argsPrefix).toEqual(["run", "./cmd/agent"]);
  });

  test("mode=manifest with no manifest still falls back to go run", () => {
    // Preserves the previous "always succeed" contract: callers depending on
    // the resolver as a Function<() => LocalAgentCommand> cannot handle throws.
    const command = resolveLocalAgentCommand({ mode: "manifest", distDir: tmpDir, env: {} });
    expect(command.binaryPath).toBe("go");
  });
});
