import { expect, test } from "bun:test";
import i18next from "i18next";
import { panelTabMenu } from "../../../../../src/renderer/components/agent-view/agent-pane";
import type { MenuItemSpec } from "../../../../../src/renderer/components/ui/context-menu";

function pick(items: MenuItemSpec[], label: string): () => void {
  const item = items.find((each) => each.kind === "item" && each.label === label);
  if (!item || item.kind !== "item") throw new Error(`no ${label}`);
  return item.onSelect as () => void;
}

test("an agent view tab's menu takes tabs out of the panel", () => {
  const keys = ["a", "b", "c"];
  const removed: (readonly string[])[] = [];
  const menu = panelTabMenu(keys, 1, (each) => removed.push(each));
  const items = menu();
  pick(items, i18next.t("agentView.pane.remove"))();
  pick(items, i18next.t("tabBar.close_others"))();
  pick(items, i18next.t("tabBar.close_all_right"))();
  pick(items, i18next.t("tabBar.close_all"))();
  expect(removed).toEqual([["b"], ["a", "c"], ["c"], ["a", "b", "c"]]);
  expect(
    items.some((each) => each.kind === "item" && each.label === i18next.t("tabBar.copy_path")),
  ).toBe(false);
  expect(
    menu("/repo/a.ts").some(
      (each) => each.kind === "item" && each.label === i18next.t("tabBar.copy_path"),
    ),
  ).toBe(true);
});
