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

  test("include the manager's, under the agent's", () => {
    expect(settingsNav(t).find((item) => item.id === "manager")).toMatchObject({
      parent: "agent",
    });
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
});
