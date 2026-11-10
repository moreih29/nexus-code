import { describe, expect, test } from "bun:test";
import {
  lspLanguageIdForUri,
  lspPresetLanguageIdForPath,
  resolveLspPreset,
} from "../../../src/shared/lsp/config";

describe("built-in LSP presets", () => {
  test("finds the preset serving a file by its extension", () => {
    expect(lspPresetLanguageIdForPath("/ws/src/App.TSX")).toBe("typescript");
    expect(lspPresetLanguageIdForPath("C:\\ws\\tool.mjs")).toBe("typescript");
    expect(lspPresetLanguageIdForPath("/ws/main.pyi")).toBe("python");
    expect(lspPresetLanguageIdForPath("/ws/.github/workflows/ci.yml")).toBe("yaml");
    expect(lspPresetLanguageIdForPath("/ws/compose.YAML")).toBe("yaml");
    expect(lspPresetLanguageIdForPath("/ws/scripts/build.sh")).toBe("shell");
    expect(lspPresetLanguageIdForPath("/ws/Dockerfile")).toBe("dockerfile");
    expect(lspPresetLanguageIdForPath("C:\\ws\\app.dockerfile")).toBe("dockerfile");
    expect(lspPresetLanguageIdForPath("/ws/Dockerfile.dev")).toBeNull();
    expect(lspPresetLanguageIdForPath("/ws.ts/README")).toBeNull();
    expect(lspPresetLanguageIdForPath("/ws/.py")).toBeNull();
  });

  test("sends shell scripts as LSP's shellscript", () => {
    expect(lspLanguageIdForUri("shell", "file:///ws/build.sh")).toBe("shellscript");
    expect(resolveLspPreset("shellscript")?.binary).toBe("bash-language-server");
    expect(lspLanguageIdForUri("dockerfile", "file:///ws/Dockerfile")).toBe("dockerfile");
  });
});
