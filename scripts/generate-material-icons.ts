#!/usr/bin/env bun

import fs from "node:fs/promises";
import path from "node:path";

const ROOT_DIR = path.resolve(import.meta.dir, "..");
const ICONS_SRC_DIR = path.join(ROOT_DIR, "node_modules/material-icon-theme/icons");
const MAP_OUT_PATH = path.join(
  ROOT_DIR,
  "src/renderer/components/files/file-tree/material-icon-map.json",
);
const ICONS_OUT_DIR = path.join(ROOT_DIR, "src/renderer/assets/icons/material");

const { generateManifest } = (await import(
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-expect-error – no types for material-icon-theme module
  "material-icon-theme"
)) as { generateManifest: () => MaterialIconManifest };

interface MaterialIconManifest {
  readonly iconDefinitions: Record<string, { readonly iconPath: string }>;
  readonly fileExtensions: Record<string, string>;
  readonly fileNames: Record<string, string>;
  readonly folderNames: Record<string, string>;
  readonly folderNamesExpanded: Record<string, string>;
  readonly file: string;
  readonly folder: string;
  readonly folderExpanded: string;
}

interface MaterialIconMap {
  readonly ext: Record<string, string>;
  readonly file: Record<string, string>;
  readonly folder: Record<string, string>;
  readonly folderOpen: Record<string, string>;
  readonly fileDefault: string;
  readonly folderDefault: string;
  readonly folderOpenDefault: string;
}

async function main(): Promise<void> {
  console.log("Generating Material icon map…");

  const manifest = generateManifest();

  const map: MaterialIconMap = {
    ext: { ...manifest.fileExtensions },
    file: { ...manifest.fileNames },
    folder: { ...manifest.folderNames },
    folderOpen: { ...manifest.folderNamesExpanded },
    fileDefault: manifest.file,
    folderDefault: manifest.folder,
    folderOpenDefault: manifest.folderExpanded,
  };

  const referencedNames = new Set<string>([
    ...Object.values(map.ext),
    ...Object.values(map.file),
    ...Object.values(map.folder),
    ...Object.values(map.folderOpen),
    map.fileDefault,
    map.folderDefault,
    map.folderOpenDefault,
  ]);

  console.log(`  referenced icon names: ${referencedNames.size}`);

  await fs.mkdir(path.dirname(MAP_OUT_PATH), { recursive: true });
  await fs.writeFile(MAP_OUT_PATH, `${JSON.stringify(map, null, 2)}\n`, "utf-8");
  console.log(`  wrote map → ${MAP_OUT_PATH}`);

  await fs.mkdir(ICONS_OUT_DIR, { recursive: true });

  let copiedCount = 0;
  let missingCount = 0;
  const missing: string[] = [];

  for (const iconName of referencedNames) {
    const srcFile = path.join(ICONS_SRC_DIR, `${iconName}.svg`);
    const destFile = path.join(ICONS_OUT_DIR, `${iconName}.svg`);
    try {
      await fs.copyFile(srcFile, destFile);
      copiedCount += 1;
    } catch {
      missingCount += 1;
      missing.push(iconName);
    }
  }

  if (missing.length > 0) {
    console.warn(`  WARNING: ${missingCount} icon(s) not found in source:`, missing.slice(0, 10));
  }
  console.log(`  copied ${copiedCount} SVG(s) → ${ICONS_OUT_DIR}`);
  console.log("Done.");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
