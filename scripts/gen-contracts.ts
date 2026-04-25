import Ajv2020 from "ajv/dist/2020";
import standaloneCode from "ajv/dist/standalone";
import addFormats from "ajv-formats";
import { compileFromFile } from "json-schema-to-typescript";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
] as const;

const brandImports: Record<string, string[]> = {
  "last-session-snapshot": ["WorkspaceId"],
  "workspace-registry": ["WorkspaceId"],
  "sidecar-lifecycle": ["WorkspaceId"],
  "terminal-tab": ["TerminalTabId", "WorkspaceId"],
  "terminal-lifecycle": ["TerminalTabId", "WorkspaceId"],
  "workspace-actions": ["WorkspaceId"],
  "terminal-ipc": ["TerminalTabId", "WorkspaceId"],
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

await writeFile(
  path.join(outputDir, "terminal-ipc.validate.ts"),
  await buildStandaloneValidator(path.join(schemaDir, "terminal-ipc.schema.json")),
);

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

async function buildStandaloneValidator(schemaPath: string): Promise<string> {
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  const ajv = new Ajv2020({ code: { esm: true, source: true }, strict: true });
  addFormats(ajv);

  const validate = ajv.compile(schema);
  const standalone = standaloneCode(ajv, validate);
  return `${bannerComment}\n// @ts-nocheck\n${standalone}`;
}
