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

import { describe, expect, it } from "bun:test";
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
  it("kind=folder → Folder", () => {
    expect(resolveLucide("folder")).toBe(Folder);
  });

  it("kind=folder-open → FolderOpen", () => {
    expect(resolveLucide("folder-open")).toBe(FolderOpen);
  });
});

describe("resolveLucide — file extensions", () => {
  it(".ts → FileCode", () => {
    expect(resolveLucide("file", "index.ts")).toBe(FileCode);
  });

  it(".tsx → FileCode", () => {
    expect(resolveLucide("file", "App.tsx")).toBe(FileCode);
  });

  it(".js → FileCode", () => {
    expect(resolveLucide("file", "main.js")).toBe(FileCode);
  });

  it(".jsx → FileCode", () => {
    expect(resolveLucide("file", "Component.jsx")).toBe(FileCode);
  });

  it(".json → FileJson", () => {
    expect(resolveLucide("file", "package.json")).toBe(FileJson);
  });

  it(".md → FileText", () => {
    expect(resolveLucide("file", "README.md")).toBe(FileText);
  });

  it(".py → FileCode", () => {
    expect(resolveLucide("file", "main.py")).toBe(FileCode);
  });

  it(".css → FileCode", () => {
    expect(resolveLucide("file", "styles.css")).toBe(FileCode);
  });

  it(".html → FileCode", () => {
    expect(resolveLucide("file", "index.html")).toBe(FileCode);
  });

  it(".sh → FileTerminal", () => {
    expect(resolveLucide("file", "build.sh")).toBe(FileTerminal);
  });

  it(".yaml → FileCog", () => {
    expect(resolveLucide("file", "config.yaml")).toBe(FileCog);
  });

  it(".lock → FileLock", () => {
    expect(resolveLucide("file", "bun.lock")).toBe(FileLock);
  });

  it(".png → FileImage", () => {
    expect(resolveLucide("file", "logo.png")).toBe(FileImage);
  });

  it(".zip → FileArchive", () => {
    expect(resolveLucide("file", "dist.zip")).toBe(FileArchive);
  });
});

describe("resolveLucide — exact filename match", () => {
  it("Dockerfile → FileCog (exact match beats extension)", () => {
    expect(resolveLucide("file", "Dockerfile")).toBe(FileCog);
  });

  it("Makefile → FileCog", () => {
    expect(resolveLucide("file", "Makefile")).toBe(FileCog);
  });

  it("LICENSE → FileText", () => {
    expect(resolveLucide("file", "LICENSE")).toBe(FileText);
  });

  it("README → FileText", () => {
    expect(resolveLucide("file", "README")).toBe(FileText);
  });
});

describe("resolveLucide — fallback cases", () => {
  it("no extension → File", () => {
    expect(resolveLucide("file", "Procfile")).toBe(File);
  });

  it("unknown extension → File", () => {
    expect(resolveLucide("file", "file.unknownxyz")).toBe(File);
  });

  it("undefined name → File", () => {
    expect(resolveLucide("file", undefined)).toBe(File);
  });

  it("empty string → File", () => {
    expect(resolveLucide("file", "")).toBe(File);
  });
});

describe("resolveLucide — dotfile extension matching", () => {
  it(".env → FileCog (dotfile: extension IS the whole name)", () => {
    // ".env" has the extension ".env" (lastIndexOf('.') = 0, slice(0) = ".env")
    expect(resolveLucide("file", ".env")).toBe(FileCog);
  });

  it(".gitignore → FileCog", () => {
    expect(resolveLucide("file", ".gitignore")).toBe(FileCog);
  });
});

// ---------------------------------------------------------------------------
// resolveMaterialIconName
// ---------------------------------------------------------------------------

describe("resolveMaterialIconName — folder/folder-open defaults", () => {
  it("kind=folder (unnamed) → folderDefault", () => {
    const result = resolveMaterialIconName("folder");
    // material-icon-map.json folderDefault = "folder"
    expect(result).toBe("folder");
  });

  it("kind=folder-open (unnamed) → folderOpenDefault", () => {
    const result = resolveMaterialIconName("folder-open");
    // material-icon-map.json folderOpenDefault = "folder-open"
    expect(result).toBe("folder-open");
  });
});

describe("resolveMaterialIconName — common file extensions", () => {
  it(".ts → typescript", () => {
    expect(resolveMaterialIconName("file", "index.ts")).toBe("typescript");
  });

  it(".tsx → react_ts", () => {
    expect(resolveMaterialIconName("file", "App.tsx")).toBe("react_ts");
  });

  it(".js → javascript", () => {
    expect(resolveMaterialIconName("file", "main.js")).toBe("javascript");
  });

  it(".jsx → react", () => {
    expect(resolveMaterialIconName("file", "Component.jsx")).toBe("react");
  });

  it(".json → json (non-special filename)", () => {
    // package.json is an exact-filename match → nodejs; use a generic name
    expect(resolveMaterialIconName("file", "data.json")).toBe("json");
  });

  it(".md → markdown (non-special filename)", () => {
    // README.md and CHANGELOG.md have exact matches; use a truly generic name
    expect(resolveMaterialIconName("file", "notes.md")).toBe("markdown");
  });

  it(".py → python", () => {
    expect(resolveMaterialIconName("file", "main.py")).toBe("python");
  });

  it(".css → css", () => {
    expect(resolveMaterialIconName("file", "styles.css")).toBe("css");
  });

  it(".html → html", () => {
    expect(resolveMaterialIconName("file", "index.html")).toBe("html");
  });

  it(".rs → rust", () => {
    expect(resolveMaterialIconName("file", "main.rs")).toBe("rust");
  });

  it(".go → go", () => {
    expect(resolveMaterialIconName("file", "main.go")).toBe("go");
  });
});

describe("resolveMaterialIconName — multi-segment suffix priority", () => {
  it("d.ts suffix wins over ts suffix → typescript-def", () => {
    // "types.d.ts": first dot is at index 5 → suffix "d.ts" → typescript-def
    expect(resolveMaterialIconName("file", "types.d.ts")).toBe("typescript-def");
  });

  it("spec.tsx suffix wins over tsx → test-jsx", () => {
    expect(resolveMaterialIconName("file", "App.spec.tsx")).toBe("test-jsx");
  });

  it("test.ts suffix wins over ts → test-ts", () => {
    expect(resolveMaterialIconName("file", "main.test.ts")).toBe("test-ts");
  });

  it("stories.tsx suffix wins over tsx → storybook", () => {
    expect(resolveMaterialIconName("file", "Button.stories.tsx")).toBe("storybook");
  });
});

describe("resolveMaterialIconName — exact filename match", () => {
  it(".gitignore exact match wins over extension", () => {
    // The `file` map has ".gitignore" → "git"
    const result = resolveMaterialIconName("file", ".gitignore");
    expect(result).toBe("git");
  });

  it("dockerfile exact match (case-insensitive)", () => {
    const result = resolveMaterialIconName("file", "Dockerfile");
    expect(result).toBe("docker");
  });

  it("docker-compose.yml exact match → docker", () => {
    const result = resolveMaterialIconName("file", "docker-compose.yml");
    expect(result).toBe("docker");
  });
});

describe("resolveMaterialIconName — fileDefault fallback", () => {
  it("completely unknown extension → 'file' (fileDefault)", () => {
    const result = resolveMaterialIconName("file", "archive.unknownxyz123");
    expect(result).toBe("file");
  });

  it("no extension → 'file' (fileDefault, no exact match)", () => {
    // Procfile has an exact match → heroku; use a name with no match
    const result = resolveMaterialIconName("file", "SomeRandomFile");
    expect(result).toBe("file");
  });

  it("undefined name → 'file' (fileDefault)", () => {
    const result = resolveMaterialIconName("file", undefined);
    expect(result).toBe("file");
  });
});

describe("resolveMaterialIconName — case insensitivity", () => {
  it("uppercase extension still resolves correctly", () => {
    // The ext map uses lowercase keys; the resolver lowercases the filename.
    expect(resolveMaterialIconName("file", "Main.TS")).toBe("typescript");
    expect(resolveMaterialIconName("file", "App.TSX")).toBe("react_ts");
  });
});
