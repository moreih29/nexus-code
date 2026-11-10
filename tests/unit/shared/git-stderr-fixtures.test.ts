import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ClassifiedErrorSchema } from "../../../src/shared/git/types";

const fixtureRoot = join(import.meta.dir, "../../fixtures/git/stderr");

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

  test("expected error JSON conforms to the shared schema", () => {
    for (const caseName of cases) {
      expect(() => expectedError(caseName)).not.toThrow();
    }
  });
});
