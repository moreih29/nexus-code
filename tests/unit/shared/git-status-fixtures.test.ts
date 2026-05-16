import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GitStatusSchema } from "../../../src/shared/git/types";

const fixtureRoot = join(import.meta.dir, "../../fixtures/git/status");
const requiredFixtureFiles = ["stdout.bin", "expected.json", "meta.json"] as const;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function expectedStatus(caseName: string) {
  return GitStatusSchema.parse(readJson(join(fixtureRoot, caseName, "expected.json")));
}

describe("git status parity fixtures", () => {
  const cases = readdirSync(fixtureRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  test("provide a reviewable fixture triplet for every case", () => {
    expect(cases.length).toBeGreaterThanOrEqual(12);

    for (const caseName of cases) {
      const caseDir = join(fixtureRoot, caseName);
      for (const fileName of requiredFixtureFiles) {
        expect(existsSync(join(caseDir, fileName))).toBe(true);
      }

      const meta = readJson(join(caseDir, "meta.json")) as Record<string, unknown>;
      expect(meta.gitVersion).toBeString();
      expect(meta.LANG).toBe("C");
      expect(["synthetic", "manual-capture"]).toContain(meta.source);
      expect(readFileSync(join(caseDir, "stdout.bin")).byteLength).toBeGreaterThan(0);
    }
  });

  test("expected status JSON conforms to the shared schema", () => {
    for (const caseName of cases) {
      expect(() => expectedStatus(caseName)).not.toThrow();
    }
  });

  test("explicitly preserves status serialization traps", () => {
    expect(expectedStatus("upstream-null").branch?.upstream).toBeNull();

    const oldRelPathTrap = expectedStatus("oldrelpath-omitted-trap").staged[0];
    expect(Object.hasOwn(oldRelPathTrap, "oldRelPath")).toBe(false);

    expect(expectedStatus("conflicttype-null-trap").working[0]?.conflictType).toBeNull();
    expect(expectedStatus("last-fetched-null-trap").lastFetchedAt).toBeNull();
    expect(expectedStatus("last-fetched-zero-valid").lastFetchedAt).toBe(0);

    const mergeState = expectedStatus("operation-merge-state").operationState;
    expect(mergeState.kind).toBe("merge");
    if (mergeState.kind === "merge") {
      expect(mergeState.mergeRef).toBe("feature/status-conflict");
      expect(mergeState.conflictCount).toBe(1);
    }
  });
});
