import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { capturePyrightFixtureSnapshots } from "../../scripts/capture-pyright-fixtures";
import {
  CompletionItemSchema,
  DocumentHighlightSchema,
  DocumentSymbolSchema,
  HoverResultSchema,
  LocationSchema,
  SymbolInformationSchema,
} from "../../src/shared/lsp-types";

interface FixtureSnapshot {
  pyrightVersion: string;
  workspaceRoot: string;
  response: {
    result?: unknown;
  };
}

const RESPONSE_DIR = resolve(import.meta.dir, "../fixtures/lsp/pyright/responses");
const LSP_INTEGRATION_ENABLED = process.env.LSP_INTEGRATION === "1";
const integrationTest = LSP_INTEGRATION_ENABLED ? test : test.skip;

const fixtureNames = [
  "hover-module_a-greet",
  "definition-module_b-greeter",
  "completion-module_a-context",
  "references-module_a-class",
  "references-module_b-cross-file",
  "document-symbol-module_a",
  "document-highlight-module_a-readwrite",
  "workspace-symbol-greet",
] as const;

type FixtureName = (typeof fixtureNames)[number];

const CompletionListSchema = z
  .object({
    isIncomplete: z.boolean(),
    items: z.array(CompletionItemSchema.passthrough()),
  })
  .passthrough();

const resultSchemas: Record<FixtureName, z.ZodTypeAny> = {
  "hover-module_a-greet": HoverResultSchema,
  "definition-module_b-greeter": z.array(LocationSchema),
  "completion-module_a-context": z
    .array(CompletionItemSchema.passthrough())
    .or(CompletionListSchema),
  "references-module_a-class": z.array(LocationSchema),
  "references-module_b-cross-file": z.array(LocationSchema),
  "document-symbol-module_a": z.array(DocumentSymbolSchema),
  "document-highlight-module_a-readwrite": z.array(DocumentHighlightSchema),
  "workspace-symbol-greet": z.array(SymbolInformationSchema),
};

function loadFixture(name: FixtureName): FixtureSnapshot {
  return JSON.parse(readFileSync(resolve(RESPONSE_DIR, `${name}.json`), "utf8")) as FixtureSnapshot;
}

describe("Pyright live LSP fixture capture", () => {
  integrationTest("captures responses matching stable fixtures", async () => {
    const liveSnapshots = await capturePyrightFixtureSnapshots({ writeSnapshots: false });

    expect([...liveSnapshots.keys()]).toEqual([...fixtureNames]);
    for (const name of fixtureNames) {
      const liveSnapshot = liveSnapshots.get(name);
      if (!liveSnapshot) throw new Error(`Missing live snapshot ${name}`);
      const stableFixture = loadFixture(name);

      expect(resultSchemas[name].safeParse(liveSnapshot.response.result).success).toBe(true);
      expect(liveSnapshot.pyrightVersion).toBe("1.1.409");
      expect(liveSnapshot.workspaceRoot).toBe("file:///__PYRIGHT_FIXTURE_WORKSPACE__");
      expect(liveSnapshot).toEqual(stableFixture);
    }
  });
});
