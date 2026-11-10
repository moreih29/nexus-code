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

  test("⌘⌥I (DevTools) is NOT intercepted — left to the Electron menu role", () => {
    updateBrowserKeybindings(undefined);
    const run = mock((_cmd: string, _tab: string) => {});
    const h = fakeWc();
    installBrowserKeyInterceptor(h.wc, "t", run);

    const r = h.press({ type: "keyDown", code: "KeyI", ...primaryMod({ alt: true }) });
    expect(r.prevented).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  test("Ctrl+PageUp/PageDown cycle tabs from the page on Win/Linux only", () => {
    updateBrowserKeybindings(undefined);
    const run = mock((_cmd: string, _tab: string) => {});
    const h = fakeWc();
    installBrowserKeyInterceptor(h.wc, "t", run);

    const up = h.press({ type: "keyDown", code: "PageUp", control: true });
    const down = h.press({ type: "keyDown", code: "PageDown", control: true });
    expect(up.prevented).toBe(!IS_MAC);
    expect(down.prevented).toBe(!IS_MAC);
    expect(run.mock.calls.map((c) => c[0])).toEqual(
      IS_MAC ? [] : [COMMANDS.tabFocusPrev, COMMANDS.tabFocusNext],
    );
  });

  test("keys the page uses stay with the page", () => {
    updateBrowserKeybindings(undefined);
    const run = mock((_cmd: string, _tab: string) => {});
    const h = fakeWc();
    installBrowserKeyInterceptor(h.wc, "t", run);

    // copy, paste, find, save, open, bold (files panel), ⌘K chords, symbol search
    for (const [code, extra] of [
      ["KeyC", {}],
      ["KeyV", {}],
      ["KeyF", {}],
      ["KeyS", {}],
      ["KeyO", {}],
      ["KeyE", {}],
      ["KeyB", {}],
      ["KeyK", {}],
      ["KeyO", { shift: true }],
    ] as const) {
      expect(h.press({ type: "keyDown", code, ...primaryMod(extra) }).prevented).toBe(false);
    }
    expect(run).not.toHaveBeenCalled();
  });
});
