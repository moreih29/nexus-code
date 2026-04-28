import { compileFromFile } from "json-schema-to-typescript";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaDir = path.join(root, "schema");
const outputDir = path.join(root, "packages/shared/src/contracts/generated");
const bannerComment = "/* AUTO-GENERATED. DO NOT EDIT. Regenerate via `bun run gen:contracts`. */";

const schemas = [
  "last-session-snapshot",
  "workspace-registry",
  "sidecar-lifecycle",
  "terminal-tab",
  "terminal-lifecycle",
  "workspace-actions",
  "terminal-ipc",
  "harness-observer",
  "lsp-lifecycle",
  "lsp-relay",
  "search-lifecycle",
  "search-relay",
  "git-lifecycle",
  "git-relay",
] as const;

const brandImports: Record<string, string[]> = {
  "last-session-snapshot": ["WorkspaceId"],
  "workspace-registry": ["WorkspaceId"],
  "sidecar-lifecycle": ["WorkspaceId"],
  "terminal-tab": ["TerminalTabId", "WorkspaceId"],
  "terminal-lifecycle": ["TerminalTabId", "WorkspaceId"],
  "workspace-actions": ["WorkspaceId"],
  "terminal-ipc": ["TerminalTabId", "WorkspaceId"],
  "harness-observer": ["WorkspaceId"],
  "lsp-lifecycle": ["WorkspaceId"],
  "lsp-relay": ["WorkspaceId"],
  "search-lifecycle": ["WorkspaceId"],
  "search-relay": ["WorkspaceId"],
  "git-lifecycle": ["WorkspaceId"],
  "git-relay": ["WorkspaceId"],
};

await mkdir(outputDir, { recursive: true });

for (const name of schemas) {
  const schemaPath = path.join(schemaDir, `${name}.schema.json`);
  const generated = await compileFromFile(schemaPath, {
    bannerComment,
    unreachableDefinitions: true,
    style: {
      bracketSpacing: false,
      printWidth: 100,
      semi: true,
      singleQuote: false,
      tabWidth: 2,
      trailingComma: "all",
      useTabs: false,
    },
  });

  await writeFile(path.join(outputDir, `${name}.ts`), applyBrandImports(generated, brandImports[name]));
}

function applyBrandImports(source: string, brands: string[]): string {
  let output = source;
  const removed = [] as string[];

  for (const brand of brands) {
    const typeAlias = new RegExp(`\\nexport type ${brand} = string;\\n`, "g");
    if (typeAlias.test(output)) {
      output = output.replace(typeAlias, "\n");
      removed.push(brand);
    }
  }

  if (removed.length === 0) {
    return output;
  }

  const importLine = `import type { ${removed.sort().join(", ")} } from "../_brands";\n\n`;
  return output.replace(`${bannerComment}\n`, `${bannerComment}\n${importLine}`);
}
