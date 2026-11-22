import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { MAX_SEARCHABLE_FILE_SIZE } from "../../../src/shared/fs/defaults";
import { TextSearchQuerySchema } from "../../../src/shared/search/types";

it("uses the Go agent's text search file size limit for default queries", () => {
  const serviceGo = readFileSync(
    new URL("../../../internal/search/service.go", import.meta.url),
    "utf8",
  );
  const expression = serviceGo.match(
    /^\s*maxSearchFileSize\s*=\s*(\d+(?:[ \t]*\*[ \t]*\d+)*)$/m,
  )?.[1];
  if (!expression) throw new Error("Could not read maxSearchFileSize from the Go agent source");

  const agentMaxFileSize = expression
    .split("*")
    .reduce((bytes, factor) => bytes * Number(factor), 1);
  expect(TextSearchQuerySchema.parse({ pattern: "needle" }).maxFileSize).toBe(agentMaxFileSize);
  expect(MAX_SEARCHABLE_FILE_SIZE).toBe(agentMaxFileSize);
});
