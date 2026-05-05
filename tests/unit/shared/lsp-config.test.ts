import { describe, expect, test } from "bun:test";
import {
  BUILTIN_LSP_PRESETS,
  isSupportedLspLanguage,
  resolveLspPreset,
} from "../../../src/shared/lsp-config";

describe("built-in LSP presets", () => {
  test("includes Pyright for Python", () => {
    expect(BUILTIN_LSP_PRESETS.map((preset) => preset.languageId)).toContain("python");
    expect(resolveLspPreset("python")).toEqual({
      languageId: "python",
      binary: "pyright-langserver",
      args: ["--stdio"],
      initializationOptions: {
        "python.analysis.typeCheckingMode": "standard",
        "python.analysis.diagnosticMode": "openFilesOnly",
        "python.analysis.autoImportCompletions": true,
        "python.analysis.useLibraryCodeForTypes": true,
      },
    });
    expect(isSupportedLspLanguage("python")).toBe(true);
  });
});
