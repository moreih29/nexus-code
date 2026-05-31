/**
 * Unit tests for file-icon-resolvers.ts — resolveLucide and resolveMaterialIconName.
 *
 * Both functions are pure (no React, no Vite SVG imports, no store) so they
 * run directly in the Bun test environment without any mocking.
 *
 * Coverage:
 *   resolveLucide:
 *     - folder / folder-open → correct Lucide components
 *     - common extensions → expected Lucide icon family
 *     - exact-filename match takes precedence over extension
 *     - no extension → File fallback
 *     - unknown extension → File fallback
 *
 *   resolveMaterialIconName:
 *     - common extensions map to expected iconName (ts→typescript, tsx→react_ts, …)
 *     - multi-segment suffix (d.ts, spec.tsx) wins over single-segment
 *     - exact filename match in `file` map wins over extension map
 *     - folder / folder-open → folderDefault / folderOpenDefault
 *     - absent extension → fileDefault ("file")
 */

import { describe, expect, it, test } from "bun:test";
import {
  File,
  FileArchive,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileLock,
  FileTerminal,
  FileText,
  Folder,
  FolderOpen,
} from "lucide-react";
import {
  resolveLucide,
  resolveMaterialIconName,
} from "../../../../../../src/renderer/components/files/file-tree/file-icon-resolvers";

// ---------------------------------------------------------------------------
// resolveLucide
// ---------------------------------------------------------------------------

describe("resolveLucide — folder/folder-open", () => {
  test.each([
    ["folder",      Folder],
    ["folder-open", FolderOpen],
  ] as const)("kind=%s → expected component", (kind, expected) => {
    expect(resolveLucide(kind)).toBe(expected);
  });
});

describe("resolveLucide — file extensions", () => {
  test.each([
    ["index.ts",         FileCode],
    ["App.tsx",          FileCode],
    ["main.js",          FileCode],
    ["Component.jsx",    FileCode],
    ["package.json",     FileJson],
    ["README.md",        FileText],
    ["main.py",          FileCode],
    ["styles.css",       FileCode],
    ["index.html",       FileCode],
    ["build.sh",         FileTerminal],
    ["config.yaml",      FileCog],
    ["bun.lock",         FileLock],
    ["logo.png",         FileImage],
    ["dist.zip",         FileArchive],
  ] as const)("%s → expected Lucide component", (name, expected) => {
    expect(resolveLucide("file", name)).toBe(expected);
  });
});

describe("resolveLucide — exact filename match", () => {
  test.each([
    ["Dockerfile", FileCog,  "exact match beats extension"],
    ["Makefile",   FileCog,  "exact match"],
    ["LICENSE",    FileText, "exact match"],
    ["README",     FileText, "exact match"],
  ] as const)("%s → %s (%s)", (name, expected) => {
    expect(resolveLucide("file", name)).toBe(expected);
  });
});

describe("resolveLucide — fallback cases", () => {
  test.each([
    ["Procfile",        "no extension → File"],
    ["file.unknownxyz", "unknown extension → File"],
  ] as const)("%s (%s)", (name) => {
    expect(resolveLucide("file", name)).toBe(File);
  });

  it("undefined name → File", () => {
    expect(resolveLucide("file", undefined)).toBe(File);
  });

  it("empty string → File", () => {
    expect(resolveLucide("file", "")).toBe(File);
  });
});

describe("resolveLucide — dotfile extension matching", () => {
  test.each([
    [".env",       "dotfile: extension IS the whole name"],
    [".gitignore", "dotfile"],
  ] as const)("%s → FileCog (%s)", (name) => {
    expect(resolveLucide("file", name)).toBe(FileCog);
  });
});

// ---------------------------------------------------------------------------
// resolveMaterialIconName
// ---------------------------------------------------------------------------

describe("resolveMaterialIconName — folder/folder-open defaults", () => {
  test.each([
    ["folder",      "folder"],
    ["folder-open", "folder-open"],
  ] as const)("kind=%s → %s", (kind, expected) => {
    expect(resolveMaterialIconName(kind)).toBe(expected);
  });
});

describe("resolveMaterialIconName — common file extensions", () => {
  test.each([
    ["index.ts",        "typescript"],
    ["App.tsx",         "react_ts"],
    ["main.js",         "javascript"],
    ["Component.jsx",   "react"],
    ["data.json",       "json"],       // package.json is an exact-filename match → nodejs; use generic
    ["notes.md",        "markdown"],   // README.md / CHANGELOG.md have exact matches; use generic
    ["main.py",         "python"],
    ["styles.css",      "css"],
    ["index.html",      "html"],
    ["main.rs",         "rust"],
    ["main.go",         "go"],
  ] as const)("%s → %s", (name, expected) => {
    expect(resolveMaterialIconName("file", name)).toBe(expected);
  });
});

describe("resolveMaterialIconName — multi-segment suffix priority", () => {
  test.each([
    ["types.d.ts",        "typescript-def", "d.ts suffix wins over ts suffix"],
    ["App.spec.tsx",      "test-jsx",       "spec.tsx suffix wins over tsx"],
    ["main.test.ts",      "test-ts",        "test.ts suffix wins over ts"],
    ["Button.stories.tsx","storybook",      "stories.tsx suffix wins over tsx"],
  ] as const)("%s → %s (%s)", (name, expected) => {
    expect(resolveMaterialIconName("file", name)).toBe(expected);
  });
});

describe("resolveMaterialIconName — exact filename match", () => {
  test.each([
    [".gitignore",         "git",    "exact match wins over extension"],
    ["Dockerfile",         "docker", "case-insensitive exact match"],
    ["docker-compose.yml", "docker", "exact match"],
  ] as const)("%s → %s (%s)", (name, expected) => {
    expect(resolveMaterialIconName("file", name)).toBe(expected);
  });
});

describe("resolveMaterialIconName — fileDefault fallback", () => {
  test.each([
    ["archive.unknownxyz123", "completely unknown extension"],
    ["SomeRandomFile",        "no extension, no exact match"],
  ] as const)("%s (%s) → 'file'", (name) => {
    expect(resolveMaterialIconName("file", name)).toBe("file");
  });

  it("undefined name → 'file' (fileDefault)", () => {
    expect(resolveMaterialIconName("file", undefined)).toBe("file");
  });
});

describe("resolveMaterialIconName — case insensitivity", () => {
  it("uppercase extension still resolves correctly", () => {
    // The ext map uses lowercase keys; the resolver lowercases the filename.
    expect(resolveMaterialIconName("file", "Main.TS")).toBe("typescript");
    expect(resolveMaterialIconName("file", "App.TSX")).toBe("react_ts");
  });
});
