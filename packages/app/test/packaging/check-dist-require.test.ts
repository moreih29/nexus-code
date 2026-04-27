import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = spawnSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: import.meta.dir,
  encoding: "utf8",
}).stdout.trim();

const CHECK_DIST_REQUIRE_SCRIPT = join(REPO_ROOT, "scripts/check-dist-require.sh");

describe("check-dist-require", () => {
  test("fails on bare CommonJS require calls", () => {
    withTempArtifactRoot((artifactRoot) => {
      writeFileSync(
        join(artifactRoot, "bare-require.js"),
        "const ajv = require('ajv');\n",
        "utf8",
      );

      const result = runCheckDistRequire(artifactRoot);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("forbidden CommonJS require(...) calls found");
      expect(result.stderr).toContain("bare-require.js");
    });
  });

  test("allows member calls named require", () => {
    withTempArtifactRoot((artifactRoot) => {
      writeFileSync(
        join(artifactRoot, "member-require.js"),
        [
          "host.require(resolvedPath, pluginConfigEntry.name);",
          "host?.require(optionalPath);",
          "host . require(spacedPath);",
        ].join("\n"),
        "utf8",
      );

      const result = runCheckDistRequire(artifactRoot);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("no forbidden require(...) calls found");
    });
  });
});

function runCheckDistRequire(artifactRoot: string): ReturnType<typeof spawnSync> {
  return spawnSync("bash", [CHECK_DIST_REQUIRE_SCRIPT, artifactRoot], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

function withTempArtifactRoot(run: (artifactRoot: string) => void): void {
  const artifactRoot = mkdtempSync(join(tmpdir(), "nexus-check-dist-require-"));
  try {
    run(artifactRoot);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
}
