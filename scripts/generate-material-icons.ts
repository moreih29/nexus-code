#!/usr/bin/env bun
/**
 * generate-material-icons.ts
 *
 * Builds two artefacts from the material-icon-theme package:
 *
 *   1. src/renderer/components/files/file-tree/material-icon-map.json
 *      A single JSON that maps extension / filename / folder-name → iconName,
 *      plus the default file, folder, and folder-open icon names.
 *
 *   2. src/renderer/assets/icons/material/*.svg
 *      Every SVG that is referenced by the map, copied from
 *      node_modules/material-icon-theme/icons/.
 *
 * Run via:  bun run gen:icons
 *
 * This is a build-time-only script; material-icon-theme is a devDependency.
 * The runtime bundle consumes only the generated JSON + copied SVGs.
 */

import fs from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Paths (all absolute, resolved from the repo root = parent of scripts/).
// ---------------------------------------------------------------------------
const ROOT_DIR = path.resolve(import.meta.dir, "..");
const ICONS_SRC_DIR = path.join(ROOT_DIR, "node_modules/material-icon-theme/icons");
const MAP_OUT_PATH = path.join(
  ROOT_DIR,
  "src/renderer/components/files/file-tree/material-icon-map.json",
);
const ICONS_OUT_DIR = path.join(ROOT_DIR, "src/renderer/assets/icons/material");

// ---------------------------------------------------------------------------
// Load manifest.
// The shape of generateManifest() is identical to the static JSON shipped at
// node_modules/material-icon-theme/dist/material-icons.json.
// Verified top-level keys:
//   iconDefinitions, folderNames, folderNamesExpanded, rootFolderNames,
//   rootFolderNamesExpanded, fileExtensions, fileNames, languageIds,
//   light, highContrast, file, hidesExplorerArrows, folder, folderExpanded,
//   rootFolder, rootFolderExpanded
// ---------------------------------------------------------------------------
// biome-ignore lint/suspicious/noExplicitAny: external module has no types
const { generateManifest } = (await import(
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore – no types for material-icon-theme module
  "material-icon-theme"
)) as { generateManifest: () => MaterialIconManifest };

interface MaterialIconManifest {
  readonly iconDefinitions: Record<string, { readonly iconPath: string }>;
  readonly fileExtensions: Record<string, string>;
  readonly fileNames: Record<string, string>;
  readonly folderNames: Record<string, string>;
  readonly folderNamesExpanded: Record<string, string>;
  /** Default file icon name — key is literally "file" in the JSON */
  readonly file: string;
  /** Default closed-folder icon name — key is literally "folder" */
  readonly folder: string;
  /** Default open-folder icon name — key is literally "folderExpanded" */
  readonly folderExpanded: string;
}

// ---------------------------------------------------------------------------
// Mapping structure written to material-icon-map.json
// ---------------------------------------------------------------------------
interface MaterialIconMap {
  /** file extension (without leading dot) → iconName */
  readonly ext: Record<string, string>;
  /** exact filename → iconName */
  readonly file: Record<string, string>;
  /** folder name → iconName (closed) */
  readonly folder: Record<string, string>;
  /** folder name → iconName (open) */
  readonly folderOpen: Record<string, string>;
  /** fallback icon name for any file not matched above */
  readonly fileDefault: string;
  /** fallback icon name for any closed folder not matched above */
  readonly folderDefault: string;
  /** fallback icon name for any open folder not matched above */
  readonly folderOpenDefault: string;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log("Generating Material icon map…");

  const manifest = generateManifest();

  // Build the map.
  const map: MaterialIconMap = {
    ext: { ...manifest.fileExtensions },
    file: { ...manifest.fileNames },
    folder: { ...manifest.folderNames },
    folderOpen: { ...manifest.folderNamesExpanded },
    fileDefault: manifest.file,
    folderDefault: manifest.folder,
    folderOpenDefault: manifest.folderExpanded,
  };

  // Collect every iconName referenced by the map.
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

  // -------------------------------------------------------------------------
  // Write map JSON.
  // -------------------------------------------------------------------------
  await fs.mkdir(path.dirname(MAP_OUT_PATH), { recursive: true });
  await fs.writeFile(MAP_OUT_PATH, `${JSON.stringify(map, null, 2)}\n`, "utf-8");
  console.log(`  wrote map → ${MAP_OUT_PATH}`);

  // -------------------------------------------------------------------------
  // Copy SVG files.
  // -------------------------------------------------------------------------
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
