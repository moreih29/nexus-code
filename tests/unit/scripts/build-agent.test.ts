import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AgentManifestSchema } from "../../../src/shared/agent/manifest";
import { AGENT_BUILD_TARGETS, writeAgentManifest, copyClaudeWrapper } from "../../../scripts/build-agent";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-build-agent-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("build-agent manifest writer", () => {
  test("writes sha256 and size for agent, node, and LSP artifacts", async () => {
    const outDir = path.join(tmpDir, "dist");
    fs.mkdirSync(path.join(outDir, "runtime"), { recursive: true });
    fs.mkdirSync(path.join(outDir, "lsp"), { recursive: true });

    const agentArtifacts = AGENT_BUILD_TARGETS.map((target) => {
      const artifactPath = `agent-0.1.0-${target.os}-${target.arch}`;
      fs.writeFileSync(path.join(outDir, artifactPath), `${target.os}-${target.arch}-agent`);
      return { ...target, path: artifactPath };
    });

    const nodeArtifacts = AGENT_BUILD_TARGETS.map((target) => {
      const artifactPath = `runtime/node-v20.19.0-${target.os}-${target.arch}.tar.gz`;
      fs.writeFileSync(path.join(outDir, artifactPath), `${target.os}-${target.arch}-node`);
      return {
        ...target,
        version: "v20.19.0",
        path: artifactPath,
        entry: "bin/node",
      };
    });

    const lspArtifacts = [
      {
        name: "typescript-language-server",
        packageName: "typescript-language-server",
        version: "5.1.3",
        languages: ["typescript", "javascript"],
        path: "lsp/typescript-language-server-5.1.3.tar.gz",
        entry: "node_modules/typescript-language-server/lib/cli.mjs",
        launcher: "bin/typescript-language-server",
        argsTemplate: ["--stdio"],
      },
      {
        name: "pyright-langserver",
        packageName: "basedpyright",
        version: "1.39.5",
        languages: ["python"],
        path: "lsp/pyright-langserver-1.39.5.tar.gz",
        entry: "node_modules/basedpyright/langserver.index.js",
        launcher: "bin/pyright-langserver",
        argsTemplate: ["--stdio"],
      },
    ];
    for (const artifact of lspArtifacts) {
      fs.writeFileSync(path.join(outDir, artifact.path), `${artifact.name}-payload`);
    }

    await writeAgentManifest({
      outDir,
      version: "0.1.0",
      protocolVersion: "1",
      agentArtifacts,
      nodeArtifacts,
      lspArtifacts,
    });

    const manifest = AgentManifestSchema.parse(
      JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8")),
    );
    expect(manifest.binaries).toHaveLength(4);
    expect(manifest.runtime.node).toHaveLength(4);
    expect(manifest.lspBinaries).toHaveLength(2);

    const pyright = manifest.lspBinaries.find((artifact) => artifact.name === "pyright-langserver");
    expect(pyright?.size).toBe(Buffer.byteLength("pyright-langserver-payload"));
    expect(pyright?.sha256).toBe(
      createHash("sha256").update("pyright-langserver-payload").digest("hex"),
    );
  });
});

describe("copyClaudeWrapper", () => {
  // 실제 wrapper 소스 경로(레포 루트 기준)
  const repoRoot = path.resolve(import.meta.dir, "../../..");

  test("wrapper를 <outDir>/bin/claude로 복사하고 실행 권한 설정", async () => {
    const outDir = path.join(tmpDir, "dist-wrapper");
    const result = await copyClaudeWrapper({ rootDir: repoRoot, outDir });

    // 파일이 존재해야 한다.
    const destPath = path.join(outDir, "bin", "claude");
    expect(fs.existsSync(destPath)).toBe(true);

    // 실행 비트 확인 (Unix 권한: 0o755).
    const stat = fs.statSync(destPath);
    // eslint-disable-next-line no-bitwise
    expect(stat.mode & 0o755).toBe(0o755);

    // 반환값 경로 확인.
    expect(result.path).toBe(path.join("bin", "claude"));

    // sha256 / size 일치 검증.
    const content = fs.readFileSync(destPath);
    const expectedSha = createHash("sha256").update(content).digest("hex");
    expect(result.sha256).toBe(expectedSha);
    expect(result.size).toBe(content.length);
  });

  test("소스 wrapper에 shebang이 포함되어 있음", async () => {
    const outDir = path.join(tmpDir, "dist-wrapper-shebang");
    await copyClaudeWrapper({ rootDir: repoRoot, outDir });

    const destPath = path.join(outDir, "bin", "claude");
    const firstLine = fs.readFileSync(destPath, "utf8").split("\n")[0];
    expect(firstLine).toBe("#!/usr/bin/env bash");
  });

  test("소스 파일이 없으면 에러를 던진다", async () => {
    const outDir = path.join(tmpDir, "dist-no-src");
    await expect(
      copyClaudeWrapper({ rootDir: "/nonexistent-root-12345", outDir }),
    ).rejects.toThrow();
  });
});
