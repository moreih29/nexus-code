import { describe, expect, test } from "bun:test";
import {
  I18N_DEFAULT_NS,
  I18N_NAMESPACES,
  SUPPORTED_LANGUAGES,
  createI18n,
  resources,
} from "../../../src/shared/i18n/index";

// ---------------------------------------------------------------------------
// Namespace contract
// ---------------------------------------------------------------------------

describe("I18N_NAMESPACES", () => {
  test("contains all six expected namespaces", () => {
    const expected = ["common", "menu", "dialog", "errors", "settings", "files"];
    for (const ns of expected) {
      expect(I18N_NAMESPACES).toContain(ns as never);
    }
    expect(I18N_NAMESPACES).toHaveLength(6);
  });

  test("defaultNS is 'common'", () => {
    expect(I18N_DEFAULT_NS).toBe("common");
  });
});

// ---------------------------------------------------------------------------
// Resources structure
// ---------------------------------------------------------------------------

describe("resources", () => {
  test("has en and ko top-level keys", () => {
    expect(Object.keys(resources)).toEqual(expect.arrayContaining(["en", "ko"]));
  });

  test("en and ko each contain all six namespaces", () => {
    for (const lang of ["en", "ko"] as const) {
      for (const ns of I18N_NAMESPACES) {
        expect(resources[lang]).toHaveProperty(ns);
      }
    }
  });

  test("en.common has action subkeys", () => {
    const action = resources.en.common.action;
    expect(action.ok).toBe("OK");
    expect(action.cancel).toBe("Cancel");
    expect(action.save).toBe("Save");
    expect(action.close).toBe("Close");
  });

  test("ko.common has action subkeys in Korean", () => {
    const action = resources.ko.common.action;
    expect(action.ok).toBe("확인");
    expect(action.cancel).toBe("취소");
    expect(action.save).toBe("저장");
    expect(action.close).toBe("닫기");
  });

  test("en and ko common keys are structurally identical", () => {
    expect(Object.keys(resources.en.common)).toEqual(Object.keys(resources.ko.common));
    expect(Object.keys(resources.en.common.action)).toEqual(
      Object.keys(resources.ko.common.action),
    );
  });
});

// ---------------------------------------------------------------------------
// SUPPORTED_LANGUAGES
// ---------------------------------------------------------------------------

describe("SUPPORTED_LANGUAGES", () => {
  test("contains en and ko", () => {
    expect(SUPPORTED_LANGUAGES).toContain("en");
    expect(SUPPORTED_LANGUAGES).toContain("ko");
    expect(SUPPORTED_LANGUAGES).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// createI18n factory
// ---------------------------------------------------------------------------

describe("createI18n", () => {
  test("defaults lng to 'en' when no options provided", () => {
    const { options } = createI18n();
    expect(options.lng).toBe("en");
  });

  test("accepts an explicit language", () => {
    const { options } = createI18n({ lng: "ko" });
    expect(options.lng).toBe("ko");
  });

  test("fallbackLng is always 'en'", () => {
    const { options } = createI18n({ lng: "ko" });
    expect(options.fallbackLng).toBe("en");
  });

  test("ns list matches I18N_NAMESPACES", () => {
    const { options } = createI18n();
    expect(options.ns).toEqual(I18N_NAMESPACES);
  });

  test("defaultNS is 'common'", () => {
    const { options } = createI18n();
    expect(options.defaultNS).toBe("common");
  });

  test("resources object is bundled (no backend needed)", () => {
    const { options } = createI18n();
    expect(options.resources).toBeDefined();
    expect((options.resources as typeof resources).en.common).toBeDefined();
  });

  test("returnNull is false", () => {
    const { options } = createI18n();
    expect(options.returnNull).toBe(false);
  });

  test("interpolation.escapeValue is false (React escapes)", () => {
    const { options } = createI18n();
    expect((options.interpolation as { escapeValue: boolean }).escapeValue).toBe(false);
  });
});
