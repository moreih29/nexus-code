import { describe, expect, test } from "bun:test";

import { FILE_ICON_DEFAULT_SIZE, FileIconView } from "./FileIcon";
import {
  createFileIconSvgLoader,
  loadFileIconSvgState,
  type FileIconSvgModuleMap,
} from "./file-icon-loader";
import { resolveFileIconSource } from "./file-icon-resolver";

describe("FileIcon source resolution", () => {
  test("maps diverse file names through vscode-icons-js", () => {
    const cases: Array<[string, string]> = [
      ["main.py", "file_type_python.svg"],
      ["data.json", "file_type_light_json.svg"],
      ["package.json", "file_type_npm.svg"],
      ["README.md", "file_type_markdown.svg"],
      ["index.ts", "file_type_typescript.svg"],
      ["App.tsx", "file_type_reactts.svg"],
      ["config.yml", "file_type_light_yaml.svg"],
      [".gitignore", "file_type_git.svg"],
      ["image.png", "file_type_image.svg"],
      ["vector.svg", "file_type_svg.svg"],
      ["main.go", "file_type_go.svg"],
      ["script.sh", "file_type_shell.svg"],
    ];

    expect(cases).toHaveLength(12);
    for (const [name, expectedIcon] of cases) {
      expect(resolveFileIconSource({ name, kind: "file" }).fileName).toBe(expectedIcon);
    }
  });

  test("maps folder open and closed states", () => {
    expect(resolveFileIconSource({ name: "src", kind: "folder" })).toMatchObject({
      fileName: "folder_type_src.svg",
      folderState: "closed",
      usesLibraryDefault: false,
    });
    expect(resolveFileIconSource({ name: "src", kind: "folder", folderState: "open" })).toMatchObject({
      fileName: "folder_type_src_opened.svg",
      folderState: "open",
      usesLibraryDefault: false,
    });
  });

  test("falls back to the library default SVG for unmatched file names", () => {
    expect(resolveFileIconSource({ name: "unknown.nexus-unmatched", kind: "file" })).toMatchObject({
      fileName: "default_file.svg",
      usesLibraryDefault: true,
    });
  });
});

describe("FileIcon lazy SVG loading", () => {
  test("loads SVG text from a Vite glob-compatible module map", async () => {
    const modules: FileIconSvgModuleMap = {
      "../../assets/file-icons/file_type_python.svg": async () => "<svg viewBox=\"0 0 32 32\"></svg>",
      "../../assets/file-icons/default_file.svg": async () => ({ default: "<svg viewBox=\"0 0 32 32\"></svg>" }),
    };
    const loadSvg = createFileIconSvgLoader(modules);

    await expect(loadSvg("file_type_python.svg")).resolves.toContain("<svg");
    await expect(loadSvg("default_file.svg")).resolves.toContain("<svg");
  });

  test("renders a placeholder state and warns on SVG load failure", async () => {
    const source = resolveFileIconSource({ name: "main.py", kind: "file" });
    const warnings: unknown[] = [];
    const loaded = await loadFileIconSvgState(
      source,
      async () => {
        throw new Error("simulated missing SVG chunk");
      },
      (_message, details) => warnings.push(details),
    );

    expect(loaded.status).toBe("failed");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      iconFileName: "file_type_python.svg",
      requestedName: "main.py",
      kind: "file",
    });

    const view = FileIconView({
      loadState: loaded.status,
      source,
      svg: loaded.svg,
    });
    expect(view.props["data-file-icon-state"]).toBe("failed");
    expect(view.props.style).toEqual({ width: FILE_ICON_DEFAULT_SIZE, height: FILE_ICON_DEFAULT_SIZE });
  });

  test("uses a 14px default size and preserves caller className", () => {
    const source = resolveFileIconSource({ name: "README.md", kind: "file" });
    const view = FileIconView({
      className: "opacity-80",
      loadState: "loaded",
      source,
      svg: "<svg viewBox=\"0 0 32 32\"></svg>",
    });

    expect(view.props.style).toEqual({ width: 14, height: 14 });
    expect(view.props.className).toContain("opacity-80");
    expect(view.props["data-file-icon-source"]).toBe("file_type_markdown.svg");
  });
});
