import { describe, expect, test } from "bun:test";
import {
  BUILTIN_LSP_PRESETS,
  isSupportedLspLanguage,
  resolveLspPreset,
} from "../../../src/shared/lsp/config";
import { LSP_FEATURE_ENABLED } from "../../../src/shared/lsp/feature-flag";

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

    // isSupportedLspLanguage returns false when LSP_FEATURE_ENABLED is false.
    expect(isSupportedLspLanguage("python")).toBe(LSP_FEATURE_ENABLED);
  });
});
