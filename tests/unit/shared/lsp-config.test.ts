import { describe, expect, test } from "bun:test";
import {
  BUILTIN_LSP_PRESETS,
  isSupportedLspLanguage,
  lspPresetLanguageIdForPath,
  resolveLspPreset,
} from "../../../src/shared/lsp/config";

describe("built-in LSP presets", () => {
  test("includes Pyright for Python", () => {
    expect(BUILTIN_LSP_PRESETS.map((preset) => preset.languageId)).toContain("python");

    const preset = resolveLspPreset("python");

    // Contract fields: the caller relies on these to launch the server.
    expect(preset?.languageId).toBe("python");
    expect(preset?.binary).toBe("pyright-langserver");
    expect(preset?.args).toEqual(["--stdio"]);

    // Spot-check key initializationOptions without pinning the whole object,
    // so an intentional default change does not force an unrelated test edit.
    const opts = preset?.initializationOptions as Record<string, unknown>;
    expect(opts["python.analysis.typeCheckingMode"]).toBe("standard");
    expect(opts["python.analysis.autoImportCompletions"]).toBe(true);
  });

  test("supports the preset languages and their aliases", () => {
    expect(isSupportedLspLanguage("python")).toBe(true);
    expect(isSupportedLspLanguage("typescriptreact")).toBe(true);
    expect(isSupportedLspLanguage("markdown")).toBe(false);
  });

  test("finds the preset serving a file by its extension", () => {
    expect(lspPresetLanguageIdForPath("/ws/src/App.TSX")).toBe("typescript");
    expect(lspPresetLanguageIdForPath("C:\\ws\\tool.mjs")).toBe("typescript");
    expect(lspPresetLanguageIdForPath("/ws/main.pyi")).toBe("python");
    expect(lspPresetLanguageIdForPath("/ws/.github/workflows/ci.yml")).toBe("yaml");
    expect(lspPresetLanguageIdForPath("/ws/compose.YAML")).toBe("yaml");
    expect(lspPresetLanguageIdForPath("/ws.ts/README")).toBeNull();
    expect(lspPresetLanguageIdForPath("/ws/.py")).toBeNull();
  });
});
