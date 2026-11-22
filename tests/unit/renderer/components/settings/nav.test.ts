import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { settingsNav } from "../../../../../src/renderer/components/settings/nav";

const t = ((key: string) => key) as unknown as TFunction<"settings">;

describe("the settings dialog's pages", () => {
  test("are each listed once, a page under another after it, About at the foot", () => {
    const nav = settingsNav(t);
    const ids = nav.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    nav.forEach((item, i) => {
      if (item.parent) expect(ids.slice(0, i)).toContain(item.parent);
    });
    expect(nav.at(-1)).toMatchObject({ id: "about", footer: true });
    expect(nav.filter((item) => item.footer)).toHaveLength(1);
  });

  test("show the dot on the pages told, and on none by default", () => {
    expect(settingsNav(t).some((item) => item.dirty)).toBe(false);
    const dotted = settingsNav(t, { editor: true, terminal: false })
      .filter((item) => item.dirty)
      .map((item) => item.id);
    expect(dotted).toEqual(["editor"]);
  });

  test("are found by Korean words too, for the pages whose names a Korean search would miss", () => {
    const nav = settingsNav(t);
    const keywords = (id: string) => nav.find((item) => item.id === id)?.keywords ?? [];
    expect(keywords("keybindings")).toContain("단축키");
    expect(keywords("claude")).toContain("프로필");
  });

  test("find every page that holds a font setting by the Korean word for font", () => {
    const found = settingsNav(t)
      .filter((item) => item.keywords?.some((k) => k.includes("글꼴")))
      .map((item) => item.id);
    expect(found).toEqual(expect.arrayContaining(["editor", "terminal", "agent"]));
  });

  test("give each English keyword page a Korean word as well", () => {
    const hangul = /[\uAC00-\uD7A3]/;
    for (const item of settingsNav(t)) {
      if (!item.keywords?.length) continue;
      expect({ id: item.id, korean: item.keywords.some((k) => hangul.test(k)) }).toEqual({
        id: item.id,
        korean: true,
      });
    }
  });
});
