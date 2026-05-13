import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ClassifiedErrorSchema } from "../../../src/shared/types/git";

const fixtureRoot = join(import.meta.dir, "../../fixtures/git/stderr");
const requiredFixtureFiles = ["stderr.bin", "expected.json", "meta.json"] as const;
const allowedSources = [
  "common-lang-c",
  "git-po-en",
  "manual-capture",
  "bug-report-like-synthetic",
] as const;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function caseNames(): string[] {
  return readdirSync(fixtureRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function expectedError(caseName: string) {
  return ClassifiedErrorSchema.parse(readJson(join(fixtureRoot, caseName, "expected.json")));
}

describe("git stderr parity fixtures", () => {
  const cases = caseNames();

  test("provide 50+ reviewable fixture triplets", () => {
    expect(cases.length).toBeGreaterThanOrEqual(50);

    for (const caseName of cases) {
      const caseDir = join(fixtureRoot, caseName);
      for (const fileName of requiredFixtureFiles) {
        expect(existsSync(join(caseDir, fileName))).toBe(true);
      }

      const meta = readJson(join(caseDir, "meta.json")) as Record<string, unknown>;
      expect(meta.gitVersion).toBeString();
      expect(meta.LANG).toBe("C");
      expect(allowedSources).toContain(meta.source as (typeof allowedSources)[number]);
      expect(meta.notes).toBeString();
      expect(readFileSync(join(caseDir, "stderr.bin")).byteLength).toBeGreaterThan(0);
    }
  });

  test("expected error JSON conforms to the shared schema", () => {
    for (const caseName of cases) {
      expect(() => expectedError(caseName)).not.toThrow();
    }
  });

  test("includes required priority-collision sentinels", () => {
    const collisionCases = cases.filter((caseName) => {
      const meta = readJson(join(fixtureRoot, caseName, "meta.json")) as Record<string, unknown>;
      return Array.isArray(meta.priorityCollision);
    });

    expect(collisionCases.length).toBeGreaterThanOrEqual(5);
    expect(expectedError("priority-local-changes-over-conflict").kind).toBe(
      "local-changes-overwritten",
    );
    expect(expectedError("priority-auth-required-over-auth").kind).toBe("auth-required");
    expect(expectedError("priority-force-push-over-non-fast-forward").kind).toBe(
      "force-push-rejected",
    );
    expect(expectedError("priority-protected-branch-over-push-rejected").kind).toBe(
      "protected-branch",
    );
    expect(expectedError("priority-pre-receive-over-push-rejected").kind).toBe(
      "pre-receive-hook-rejected",
    );
    expect(expectedError("priority-branch-not-fully-merged-over-branch-not-merged").kind).toBe(
      "branch-not-fully-merged",
    );
  });

  test("includes an explicit locale-drift unknown case", () => {
    expect(expectedError("unknown-locale-drift-not-repo-es").kind).toBe("unknown");
  });
});
