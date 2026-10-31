import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkGitErrorKindParity } from "../../../scripts/check-git-error-kind-parity";
import { GitErrorKindSchema } from "../../../src/shared/git/types";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "git-error-kind-parity-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeGoKinds(root: string, kinds: readonly string[]): string {
  const goFile = path.join(root, "errors.go");
  const constants = kinds.map((kind, index) => `\tKindFixture${index} Kind = "${kind}"`).join("\n");
  writeFileSync(goFile, `package git\n\ntype Kind string\n\nconst (\n${constants}\n)\n`);
  return goFile;
}

function writeFixtureKind(root: string, kind: string): string {
  const caseDir = path.join(root, "fixtures", "case-a");
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(path.join(caseDir, "expected.json"), JSON.stringify({ kind, message: "fixture" }));
  return path.join(root, "fixtures");
}

describe("checkGitErrorKindParity", () => {
  test("the real TS schema, Go constants, and stderr fixtures agree", () => {
    // Go file and fixture root fall back to the checker's defaults, which
    // resolve from the cwd (the repo root under `bun test`).
    const result = checkGitErrorKindParity({
      tsKinds: [...GitErrorKindSchema.options],
    });

    expect(result.problems).toEqual([]);
    expect(result.fixtureKinds.length).toBeGreaterThan(0);
  });

  test("detects typo drift as both missing and extra", () => {
    const root = makeTempRoot();
    const goFile = writeGoKinds(root, ["auth", "confilct"]);

    const result = checkGitErrorKindParity({
      tsKinds: ["auth", "conflict"],
      goFile,
      fixtureRoot: path.join(root, "missing-fixtures"),
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toContain(
      "Go Kind constants missing GitErrorKindSchema values: conflict",
    );
    expect(result.problems).toContain(
      "Go Kind constants has extra values absent from GitErrorKindSchema: confilct",
    );
  });

  test("detects typo drift in fixture expected.json kind values", () => {
    const root = makeTempRoot();
    const goFile = writeGoKinds(root, ["auth", "conflict"]);
    const fixtureRoot = writeFixtureKind(root, "confilct");

    const result = checkGitErrorKindParity({
      tsKinds: ["auth", "conflict"],
      goFile,
      fixtureRoot,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toContain(
      "Fixture expected.json kind values absent from GitErrorKindSchema: confilct",
    );
    expect(result.problems).toContain(
      "Fixture expected.json kind values absent from Go Kind constants: confilct",
    );
  });
});
