import { afterEach, describe, expect, mock, test } from "bun:test";
import type { WebContents } from "electron";
import {
  installBrowserKeyInterceptor,
  updateBrowserKeybindings,
} from "../../../../../src/main/features/browser/keyboard";
import { COMMANDS } from "../../../../../src/shared/keybindings/commands";

// CmdOrCtrl resolves to ⌘ on macOS and Ctrl elsewhere — match the matcher's
// platform behaviour so the assertions hold on every CI host.
const IS_MAC = process.platform === "darwin";

interface FakeInput {
  type: "keyDown" | "keyUp";
  code: string;
  meta?: boolean;
  control?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/** Build a before-input-event Input with the platform's primary modifier set. */
function primaryMod(extra: Partial<FakeInput>): Partial<FakeInput> {
  return IS_MAC ? { meta: true, ...extra } : { control: true, ...extra };
}

function fakeWc() {
  let handler: ((event: { preventDefault: () => void }, input: FakeInput) => void) | null = null;
  const wc = {
    on(evt: string, cb: (event: { preventDefault: () => void }, input: FakeInput) => void) {
      if (evt === "before-input-event") handler = cb;
      return wc;
    },
  } as unknown as WebContents;
  return {
    wc,
    press(input: FakeInput): { prevented: boolean } {
      let prevented = false;
      handler?.(
        { preventDefault: () => (prevented = true) },
        {
          meta: false,
          control: false,
          shift: false,
          alt: false,
          ...input,
        },
      );
      return { prevented };
    },
  };
}

describe("browser-view key interceptor", () => {
  afterEach(() => {
    // Restore default bindings for isolation.
    updateBrowserKeybindings(undefined);
  });

  test("⌘R → reload, ⌘⇧R → hard reload (the reported dead shortcuts)", () => {
    updateBrowserKeybindings(undefined);
    const run = mock((_cmd: string, _tab: string) => {});
    const h = fakeWc();
    installBrowserKeyInterceptor(h.wc, "tab-1", run);

    const r = h.press({ type: "keyDown", code: "KeyR", ...primaryMod({}) });
    expect(r.prevented).toBe(true);
    expect(run).toHaveBeenCalledWith(COMMANDS.browserReload, "tab-1");

    const sr = h.press({ type: "keyDown", code: "KeyR", ...primaryMod({ shift: true }) });
    expect(sr.prevented).toBe(true);
    expect(run).toHaveBeenCalledWith(COMMANDS.browserHardReload, "tab-1");
  });

  test("back / forward / focus-url all route", () => {
    updateBrowserKeybindings(undefined);
    const run = mock((_cmd: string, _tab: string) => {});
    const h = fakeWc();
    installBrowserKeyInterceptor(h.wc, "t", run);

    h.press({ type: "keyDown", code: "BracketLeft", ...primaryMod({}) });
    h.press({ type: "keyDown", code: "BracketRight", ...primaryMod({}) });
    h.press({ type: "keyDown", code: "KeyL", ...primaryMod({}) });

    const cmds = run.mock.calls.map((c) => c[0]);
    expect(cmds).toContain(COMMANDS.browserGoBack);
    expect(cmds).toContain(COMMANDS.browserGoForward);
    expect(cmds).toContain(COMMANDS.browserFocusUrl);
  });

  test("⌘⌥I (DevTools) is NOT intercepted — left to the Electron menu role", () => {
    updateBrowserKeybindings(undefined);
    const run = mock((_cmd: string, _tab: string) => {});
    const h = fakeWc();
    installBrowserKeyInterceptor(h.wc, "t", run);

    const r = h.press({ type: "keyDown", code: "KeyI", ...primaryMod({ alt: true }) });
    expect(r.prevented).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  test("keyUp is ignored; non-bound keys pass through untouched", () => {
    updateBrowserKeybindings(undefined);
    const run = mock((_cmd: string, _tab: string) => {});
    const h = fakeWc();
    installBrowserKeyInterceptor(h.wc, "t", run);

    expect(h.press({ type: "keyUp", code: "KeyR", ...primaryMod({}) }).prevented).toBe(false);
    expect(h.press({ type: "keyDown", code: "KeyP", ...primaryMod({}) }).prevented).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  test("user override is honoured: reload moved to ⌘⇧L, old ⌘R no longer reloads", () => {
    updateBrowserKeybindings([{ command: COMMANDS.browserReload, primary: "CmdOrCtrl+Shift+L" }]);
    const run = mock((_cmd: string, _tab: string) => {});
    const h = fakeWc();
    installBrowserKeyInterceptor(h.wc, "t", run);

    h.press({ type: "keyDown", code: "KeyL", ...primaryMod({ shift: true }) });
    expect(run).toHaveBeenCalledWith(COMMANDS.browserReload, "t");

    run.mockClear();
    const r = h.press({ type: "keyDown", code: "KeyR", ...primaryMod({}) });
    // ⌘R is now unassigned among browser commands → no reload, no preventDefault.
    expect(r.prevented).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});
