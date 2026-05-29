// Guards the first-launch language resolution: the settings control's initial
// selection (useLanguageStore.preference) must use the SAME boot resolution as
// the i18next init, so on a Korean system with no prior choice the control
// reflects 한국어 instead of defaulting to English (regression: divergence
// between rendered UI language and settings focus).
//
// The test env exposes neither a global `localStorage` nor `window`, so we
// install self-contained stubs for the two globals resolveBootLanguage reads
// (localStorage + navigator) and restore them afterwards.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  LANGUAGE_STORAGE_KEY,
  resolveBootLanguage,
} from "../../../src/renderer/state/stores/language";

const g = globalThis as unknown as {
  localStorage?: Storage;
  navigator: { language: string };
};

let originalLocalStorage: Storage | undefined;
let originalNavigator: unknown;
const memory = new Map<string, string>();

beforeAll(() => {
  originalLocalStorage = g.localStorage;
  originalNavigator = g.navigator;
  g.localStorage = {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => void memory.set(k, v),
    removeItem: (k: string) => void memory.delete(k),
    clear: () => memory.clear(),
    key: () => null,
    length: 0,
  } as Storage;
  g.navigator = { language: "en-US" };
});

afterAll(() => {
  g.localStorage = originalLocalStorage;
  g.navigator = originalNavigator as { language: string };
});

beforeEach(() => {
  memory.clear();
  g.navigator = { language: "en-US" };
});

describe("resolveBootLanguage", () => {
  test("persisted localStorage choice wins over OS locale", () => {
    g.navigator = { language: "ko-KR" };
    memory.set(LANGUAGE_STORAGE_KEY, "en");
    expect(resolveBootLanguage()).toBe("en");

    memory.set(LANGUAGE_STORAGE_KEY, "ko");
    expect(resolveBootLanguage()).toBe("ko");
  });

  test("first launch on Korean system (no localStorage) → ko", () => {
    g.navigator = { language: "ko-KR" };
    expect(resolveBootLanguage()).toBe("ko");
  });

  test("first launch on non-Korean system → en", () => {
    g.navigator = { language: "fr-FR" };
    expect(resolveBootLanguage()).toBe("en");
  });

  test("invalid localStorage value falls through to OS locale", () => {
    g.navigator = { language: "ko-KR" };
    memory.set(LANGUAGE_STORAGE_KEY, "zz");
    expect(resolveBootLanguage()).toBe("ko");
  });
});
