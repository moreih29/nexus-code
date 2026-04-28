import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type { EditorTab } from "../stores/editor-store";
import {
  createTabContextMenuItems,
  runTabContextMenuAction,
} from "./tab-context-menu";

const workspaceId = "ws_alpha" as WorkspaceId;

describe("TabContextMenu", () => {
  test("builds the 8 tab actions with close-right disabled state", () => {
    const tabs = [createTab("src/one.ts"), createTab("src/two.ts")];

    const firstItems = createTabContextMenuItems({ tab: tabs[0]!, tabs });
    const lastItems = createTabContextMenuItems({ tab: tabs[1]!, tabs });

    expect(firstItems.map((item) => item.id)).toEqual([
      "close",
      "close-others",
      "close-right",
      "close-all",
      "copy-path",
      "copy-relative-path",
      "reveal",
      "split-right",
    ]);
    expect(firstItems.find((item) => item.id === "close")?.shortcut).toBe("⌘W");
    expect(firstItems.find((item) => item.id === "split-right")?.shortcut).toBe("⌘\\");
    expect(firstItems.find((item) => item.id === "close-right")?.disabled).toBe(false);
    expect(lastItems.find((item) => item.id === "close-right")?.disabled).toBe(true);
  });

  test("dispatches tab menu actions", () => {
    const tab = createTab("src/one.ts");
    const calls: string[] = [];

    runTabContextMenuAction(fakeMenuSelectEvent(), "close", "p0", tab, {
      onCloseTab(paneId, tabId) {
        calls.push(`close:${paneId}:${tabId}`);
      },
    });
    runTabContextMenuAction(fakeMenuSelectEvent(), "close-others", "p0", tab, {
      onCloseOtherTabs(paneId, tabId) {
        calls.push(`close-others:${paneId}:${tabId}`);
      },
    });
    runTabContextMenuAction(fakeMenuSelectEvent(), "close-right", "p0", tab, {
      onCloseTabsToRight(paneId, tabId) {
        calls.push(`close-right:${paneId}:${tabId}`);
      },
    });
    runTabContextMenuAction(fakeMenuSelectEvent(), "close-all", "p0", tab, {
      onCloseAllTabs(paneId) {
        calls.push(`close-all:${paneId}`);
      },
    });
    runTabContextMenuAction(fakeMenuSelectEvent(), "copy-path", "p0", tab, {
      onCopyPath(tab, pathKind) {
        calls.push(`copy:${pathKind}:${tab.path}`);
      },
    });
    runTabContextMenuAction(fakeMenuSelectEvent(), "copy-relative-path", "p0", tab, {
      onCopyPath(tab, pathKind) {
        calls.push(`copy:${pathKind}:${tab.path}`);
      },
    });
    runTabContextMenuAction(fakeMenuSelectEvent(), "reveal", "p0", tab, {
      onRevealInFinder(tab) {
        calls.push(`reveal:${tab.path}`);
      },
    });
    runTabContextMenuAction(fakeMenuSelectEvent(), "split-right", "p0", tab, {
      onSplitRight(tab) {
        calls.push(`split:${tab.path}`);
      },
    });

    expect(calls).toEqual([
      `close:p0:${tab.id}`,
      `close-others:p0:${tab.id}`,
      `close-right:p0:${tab.id}`,
      "close-all:p0",
      "copy:absolute:src/one.ts",
      "copy:relative:src/one.ts",
      "reveal:src/one.ts",
      "split:src/one.ts",
    ]);
  });

  test("blocks menu shortcuts while IME composition is active", () => {
    const tab = createTab("src/one.ts");
    const calls: string[] = [];
    const composingEvent = fakeMenuSelectEvent({ nativeEvent: { isComposing: true } });
    const keyCodeEvent = fakeMenuSelectEvent({ keyCode: 229 });

    runTabContextMenuAction(composingEvent, "close", "p0", tab, {
      onCloseTab() {
        calls.push("close");
      },
    });
    runTabContextMenuAction(keyCodeEvent, "split-right", "p0", tab, {
      onSplitRight() {
        calls.push("split");
      },
    });

    expect(calls).toEqual([]);
    expect(composingEvent.prevented).toBe(true);
    expect(keyCodeEvent.prevented).toBe(true);
  });

  test("keeps tab menu content on shadcn/Radix primitives for role=menu keyboard behavior", () => {
    const contextMenuSource = readFileSync(new URL("./ui/context-menu.tsx", import.meta.url), "utf8");
    const tabMenuSource = readFileSync(new URL("./tab-context-menu.tsx", import.meta.url), "utf8");

    expect(contextMenuSource).toContain("ContextMenuPrimitive.Content");
    expect(contextMenuSource).toContain("ContextMenuPrimitive.Item");
    expect(tabMenuSource).toContain("<ContextMenuContent");
    expect(tabMenuSource).toContain("<ContextMenuItem");
    expect(tabMenuSource).toContain("isImeMenuSelectEvent(event)");
  });
});

function createTab(path: string): EditorTab {
  return {
    id: `${workspaceId}::${path}`,
    workspaceId,
    path,
    title: path.split("/").at(-1) ?? path,
    content: "",
    savedContent: "",
    version: "v1",
    dirty: false,
    saving: false,
    errorMessage: null,
    language: null,
    monacoLanguage: "plaintext",
    lspDocumentVersion: 1,
    diagnostics: [],
    lspStatus: null,
  };
}

function fakeMenuSelectEvent(options: { nativeEvent?: { isComposing?: boolean; keyCode?: number }; keyCode?: number } = {}) {
  return {
    nativeEvent: options.nativeEvent,
    keyCode: options.keyCode,
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
}
