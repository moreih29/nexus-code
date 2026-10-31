import { describe, expect, test } from "bun:test";
import {
  isLspLanguageOn,
  isLspLanguageOnForWorkspace,
  lspInitializationOptions,
  lspServerPath,
  lspSettingsFromState,
} from "../../../src/shared/lsp/settings";

const WS = "66666666-6666-4666-8666-666666666666";

describe("language server settings", () => {
  test("nothing runs while the master switch is off", () => {
    const settings = lspSettingsFromState({});

    expect(settings.enabled).toBe(false);
    expect(isLspLanguageOn(settings, "typescript")).toBe(false);
  });

  test("a language left unset runs; one turned off does not", () => {
    const settings = lspSettingsFromState({
      lspEnabled: true,
      lspLanguages: { python: { enabled: false } },
    });

    expect(isLspLanguageOn(settings, "typescript")).toBe(true);
    expect(isLspLanguageOn(settings, "python")).toBe(false);
    expect(isLspLanguageOn(settings, "markdown")).toBe(false);
  });

  test("a server the user installs runs only once turned on", () => {
    const settings = lspSettingsFromState({
      lspEnabled: true,
      lspLanguages: { rust: { enabled: true } },
    });

    expect(isLspLanguageOn(settings, "go")).toBe(false);
    expect(isLspLanguageOn(settings, "rust")).toBe(true);
  });

  test("a server's path counts only when it says something", () => {
    const settings = lspSettingsFromState({
      lspEnabled: true,
      lspLanguages: { go: { path: "  ~/go/bin/gopls " }, rust: { path: "  " } },
    });

    expect(lspServerPath(settings, "go")).toBe("~/go/bin/gopls");
    expect(lspServerPath(settings, "rust")).toBeUndefined();
    expect(lspServerPath(settings, "python")).toBeUndefined();
  });

  test("a workspace turns off only its own languages", () => {
    const settings = lspSettingsFromState({
      lspEnabled: true,
      lspDisabledLanguagesByWorkspace: { [WS]: ["typescript"] },
    });

    expect(isLspLanguageOnForWorkspace(settings, WS, "typescript")).toBe(false);
    expect(isLspLanguageOnForWorkspace(settings, WS, "python")).toBe(true);
    expect(isLspLanguageOnForWorkspace(settings, "other", "typescript")).toBe(true);
  });

  test("TypeScript's low-memory mode drops the syntax server and typings installer", () => {
    const base = { hostInfo: "nexus-code", preferences: {} };
    const off = lspSettingsFromState({ lspEnabled: true });
    const on = lspSettingsFromState({
      lspEnabled: true,
      lspLanguages: { typescript: { lowMemory: true } },
    });

    expect(lspInitializationOptions(off, "typescript", base)).toBe(base);
    expect(lspInitializationOptions(on, "typescript", base)).toEqual({
      ...base,
      tsserver: { useSyntaxServer: "never" },
      disableAutomaticTypingAcquisition: true,
    });
    expect(lspInitializationOptions(on, "python", base)).toBe(base);
  });
});
