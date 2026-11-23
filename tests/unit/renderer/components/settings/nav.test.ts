import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { navMatches, settingsNav } from "../../../../../src/renderer/components/settings/nav";
import { resources, SUPPORTED_LANGUAGES } from "../../../../../src/shared/i18n";

const t = ((key: string) => key) as unknown as TFunction<"settings">;

function tIn(lng: (typeof SUPPORTED_LANGUAGES)[number]): TFunction<"settings"> {
  const nav = resources[lng].settings.nav as Record<string, string>;
  return ((key: string) =>
    nav[key.replace(/^nav\./, "")] ?? key) as unknown as TFunction<"settings">;
}

function search(lng: (typeof SUPPORTED_LANGUAGES)[number], q: string): string[] {
  return settingsNav(tIn(lng))
    .filter((item) => navMatches(item, q.toLowerCase()))
    .map((item) => item.id);
}

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

  test("are found by their name in every language, whichever the dialog speaks", () => {
    for (const ui of SUPPORTED_LANGUAGES) {
      for (const lng of SUPPORTED_LANGUAGES) {
        const named = settingsNav(tIn(lng));
        for (const item of settingsNav(tIn(ui))) {
          const name = named.find((other) => other.id === item.id)?.label ?? "";
          expect({ ui, lng, id: item.id, found: navMatches(item, name.toLowerCase()) }).toEqual({
            ui,
            lng,
            id: item.id,
            found: true,
          });
        }
      }
    }
  });

  test("find the notes page by its recording, summary and voice settings in either language", () => {
    for (const ui of SUPPORTED_LANGUAGES) {
      for (const q of ["음성", "녹음", "요약", "목소리", "voice", "summary", "recording"]) {
        expect({ ui, q, found: search(ui, q).includes("notes") }).toEqual({ ui, q, found: true });
      }
    }
  });

  test("find the notifications and terminal pages by the other language's name", () => {
    expect(search("en", "알림")).toContain("notifications");
    expect(search("en", "터미널")).toContain("terminal");
    expect(search("ko", "terminal")).toContain("terminal");
    expect(search("ko", "notifications")).toContain("notifications");
  });
});
