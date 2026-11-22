import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const forbidden = [
  "services/fs-mutations",
  "state/operations/files",
  "state/stores/git/operations",
  "services/editor/save",
  "services/editor/git/staging",
  "components/files/git/commit",
];

test("peer workspace components have no imports from local write paths", () => {
  const root = new URL("../../../../../src/renderer/components/peer-workspace/", import.meta.url);
  const files = [...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: fileURLToPath(root) })];
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const source = readFileSync(new URL(file, root), "utf8");
    const imports = source.matchAll(/(?:\bfrom\s+|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g);
    for (const [, path] of imports) {
      const normalized = path.replace(/^@\//, "").replace(/^(\.\.\/)+/, "");
      expect(
        forbidden.some((module) => normalized === module || normalized.startsWith(`${module}/`)),
        `${file} imports ${path}`,
      ).toBe(false);
    }
  }
});
