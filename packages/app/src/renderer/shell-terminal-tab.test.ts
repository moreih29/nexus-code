import { describe, expect, test } from "bun:test";

import type { TerminalTabId } from "../../../shared/src/contracts/terminal-tab";
import type { WorkspaceId } from "../../../shared/src/contracts/workspace";
import {
  ShellTerminalTabs,
  type ShellTerminalClipboard,
  type ShellTerminalKeyEventLike,
  type ShellTerminalSessionAdapter,
  type ShellTerminalTabView,
  type ShellTerminalTabViewCreateOptions,
  type ShellTerminalTabViewFactory,
} from "./shell-terminal-tab";

class FakeElement {
  public children: FakeElement[] = [];
  public readonly style: { display?: string } = {};
  public readonly attributes = new Map<string, string>();
  public readonly ownerDocument?: FakeDocument;

  public constructor(ownerDocument?: FakeDocument) {
    this.ownerDocument = ownerDocument;
  }

  public appendChild(child: unknown): void {
    this.children.push(child as FakeElement);
  }

  public removeChild(child: unknown): void {
    this.children = this.children.filter((candidate) => candidate !== child);
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
}

class FakeDocument {
  public createElement(_tagName: string): FakeElement {
    return new FakeElement(this);
  }
}

class FakeClipboard implements ShellTerminalClipboard {
  public readTextValue = "";
  public readonly writeCalls: string[] = [];
  public readCallCount = 0;

  public async readText(): Promise<string> {
    this.readCallCount += 1;
    return this.readTextValue;
  }

  public async writeText(value: string): Promise<void> {
    this.writeCalls.push(value);
  }
}

class FakeSessionAdapter implements ShellTerminalSessionAdapter {
  public readonly openCalls: WorkspaceId[] = [];
  public readonly closeCalls: TerminalTabId[] = [];
  public readonly inputCalls: Array<{ tabId: TerminalTabId; data: string }> = [];
  public readonly resizeCalls: Array<{ tabId: TerminalTabId; cols: number; rows: number }> = [];

  private readonly nextNonceByWorkspaceId = new Map<WorkspaceId, number>();

  public async openTab(workspaceId: WorkspaceId): Promise<{ tabId: TerminalTabId }> {
    this.openCalls.push(workspaceId);
    const nextNonce = this.nextNonceByWorkspaceId.get(workspaceId) ?? 1;
    this.nextNonceByWorkspaceId.set(workspaceId, nextNonce + 1);

    const tabId = `tt_${workspaceId}_${nextNonce.toString(36).padStart(4, "0")}` as TerminalTabId;
    return { tabId };
  }

  public async closeTab(tabId: TerminalTabId): Promise<void> {
    this.closeCalls.push(tabId);
  }

  public async input(tabId: TerminalTabId, data: string): Promise<void> {
    this.inputCalls.push({ tabId, data });
  }

  public async resize(tabId: TerminalTabId, cols: number, rows: number): Promise<void> {
    this.resizeCalls.push({ tabId, cols, rows });
  }
}

class FakeView implements ShellTerminalTabView {
  public mountCount = 0;
  public unmountCount = 0;
  public fitCount = 0;
  public readonly writes: string[] = [];
  public readonly searchNextCalls: string[] = [];
  public readonly searchPreviousCalls: string[] = [];
  public searchNextResults: boolean[] = [];
  public searchPreviousResults: boolean[] = [];
  public hasSelectionValue = false;
  public selectionText = "";
  public selectionDisposableCount = 0;

  private selectionListener: (() => void) | null = null;

  public mount(_container: HTMLElement | null | undefined): boolean {
    this.mountCount += 1;
    return true;
  }

  public unmount(): void {
    this.unmountCount += 1;
  }

  public fit(): void {
    this.fitCount += 1;
  }

  public write(data: string): void {
    this.writes.push(data);
  }

  public searchNext(term: string): boolean {
    this.searchNextCalls.push(term);
    if (this.searchNextResults.length === 0) {
      return true;
    }
    return this.searchNextResults.shift() ?? false;
  }

  public searchPrevious(term: string): boolean {
    this.searchPreviousCalls.push(term);
    if (this.searchPreviousResults.length === 0) {
      return true;
    }
    return this.searchPreviousResults.shift() ?? false;
  }

  public hasSelection(): boolean {
    return this.hasSelectionValue;
  }

  public getSelection(): string {
    return this.selectionText;
  }

  public onSelectionChange(listener: () => void): { dispose(): void } {
    this.selectionListener = listener;
    return {
      dispose: () => {
        this.selectionListener = null;
        this.selectionDisposableCount += 1;
      },
    };
  }

  public emitSelectionChange(): void {
    this.selectionListener?.();
  }
}

class FakeViewFactory implements ShellTerminalTabViewFactory {
  public readonly createCalls: ShellTerminalTabViewCreateOptions[] = [];
  public readonly viewsByTabId = new Map<TerminalTabId, FakeView>();

  public create(options: ShellTerminalTabViewCreateOptions): ShellTerminalTabView {
    this.createCalls.push(options);
    const view = new FakeView();
    this.viewsByTabId.set(options.tabId, view);
    return view;
  }
}

describe("ShellTerminalTabs", () => {
  test("keeps one XtermView per tab while switching across three workspaces via display:none", async () => {
    const document = new FakeDocument();
    const paneHost = new FakeElement(document);
    const session = new FakeSessionAdapter();
    const clipboard = new FakeClipboard();
    const viewFactory = new FakeViewFactory();
    const tabs = new ShellTerminalTabs({
      terminalPaneHost: paneHost as unknown as HTMLElement,
      session,
      clipboard,
      viewFactory,
    });

    await tabs.syncSidebarState({
      openWorkspaces: [
        { id: "ws_alpha", absolutePath: "/alpha", displayName: "Alpha" },
        { id: "ws_beta", absolutePath: "/beta", displayName: "Beta" },
        { id: "ws_gamma", absolutePath: "/gamma", displayName: "Gamma" },
      ],
      activeWorkspaceId: "ws_alpha",
    });

    const snapshotAfterInit = tabs.getSnapshot();
    const alphaTabId = snapshotAfterInit.workspaces[0]!.tabs[0]!.tabId;
    const betaTabId = snapshotAfterInit.workspaces[1]!.tabs[0]!.tabId;
    const gammaTabId = snapshotAfterInit.workspaces[2]!.tabs[0]!.tabId;

    expect(viewFactory.createCalls).toHaveLength(3);
    expect(viewFactory.viewsByTabId.get(alphaTabId)?.mountCount).toBe(1);
    expect(viewFactory.viewsByTabId.get(betaTabId)?.mountCount).toBe(1);
    expect(viewFactory.viewsByTabId.get(gammaTabId)?.mountCount).toBe(1);

    expect(findPaneDisplay(paneHost, alphaTabId)).toBe("");
    expect(findPaneDisplay(paneHost, betaTabId)).toBe("none");
    expect(findPaneDisplay(paneHost, gammaTabId)).toBe("none");

    tabs.activateWorkspace("ws_beta");
    expect(findPaneDisplay(paneHost, alphaTabId)).toBe("none");
    expect(findPaneDisplay(paneHost, betaTabId)).toBe("");
    expect(findPaneDisplay(paneHost, gammaTabId)).toBe("none");

    tabs.activateWorkspace("ws_gamma");
    expect(findPaneDisplay(paneHost, alphaTabId)).toBe("none");
    expect(findPaneDisplay(paneHost, betaTabId)).toBe("none");
    expect(findPaneDisplay(paneHost, gammaTabId)).toBe("");

    tabs.activateWorkspace("ws_alpha");
    expect(findPaneDisplay(paneHost, alphaTabId)).toBe("");
    expect(findPaneDisplay(paneHost, betaTabId)).toBe("none");
    expect(findPaneDisplay(paneHost, gammaTabId)).toBe("none");

    expect(viewFactory.createCalls).toHaveLength(3);
    expect(viewFactory.viewsByTabId.get(alphaTabId)?.mountCount).toBe(1);
    expect(viewFactory.viewsByTabId.get(betaTabId)?.mountCount).toBe(1);
    expect(viewFactory.viewsByTabId.get(gammaTabId)?.mountCount).toBe(1);
  });

  test("tracks in-buffer search with next/previous and no-more-matches state", async () => {
    const document = new FakeDocument();
    const paneHost = new FakeElement(document);
    const viewFactory = new FakeViewFactory();
    const tabs = new ShellTerminalTabs({
      terminalPaneHost: paneHost as unknown as HTMLElement,
      session: new FakeSessionAdapter(),
      clipboard: new FakeClipboard(),
      viewFactory,
    });

    await tabs.syncSidebarState({
      openWorkspaces: [
        { id: "ws_alpha", absolutePath: "/alpha", displayName: "Alpha" },
      ],
      activeWorkspaceId: "ws_alpha",
    });

    const activeTabId = tabs.getSnapshot().workspaces[0]!.activeTabId!;
    const activeView = viewFactory.viewsByTabId.get(activeTabId)!;
    activeView.searchNextResults = [false];
    activeView.searchPreviousResults = [true];

    tabs.openSearchBar();
    tabs.setSearchQuery("needle");

    expect(tabs.searchNext()).toBeFalse();
    expect(activeView.searchNextCalls).toEqual(["needle"]);
    expect(tabs.getSnapshot().search.noMoreMatches).toBeTrue();
    expect(tabs.getSnapshot().search.statusMessage).toBe("No more matches");

    expect(tabs.searchPrevious()).toBeTrue();
    expect(activeView.searchPreviousCalls).toEqual(["needle"]);
    expect(tabs.getSnapshot().search.noMoreMatches).toBeFalse();
  });

  test("wires copy-on-select and Cmd/Ctrl+C/V/F shortcuts through clipboard + terminal seams", async () => {
    const document = new FakeDocument();
    const paneHost = new FakeElement(document);
    const session = new FakeSessionAdapter();
    const clipboard = new FakeClipboard();
    const viewFactory = new FakeViewFactory();
    const tabs = new ShellTerminalTabs({
      terminalPaneHost: paneHost as unknown as HTMLElement,
      session,
      clipboard,
      viewFactory,
    });

    await tabs.syncSidebarState({
      openWorkspaces: [
        { id: "ws_alpha", absolutePath: "/alpha", displayName: "Alpha" },
      ],
      activeWorkspaceId: "ws_alpha",
    });

    const activeTabId = tabs.getSnapshot().workspaces[0]!.activeTabId!;
    const activeView = viewFactory.viewsByTabId.get(activeTabId)!;
    activeView.hasSelectionValue = true;
    activeView.selectionText = "copied";

    activeView.emitSelectionChange();
    await flushMicrotasks();
    expect(clipboard.writeCalls).toEqual(["copied"]);

    const copyEvent = createKeyEvent("c", { metaKey: true });
    expect(await tabs.handleKeyDown(copyEvent)).toBeTrue();
    expect(copyEvent.preventDefaultCount).toBe(1);
    expect(clipboard.writeCalls).toEqual(["copied", "copied"]);

    clipboard.readTextValue = "pasted";
    const pasteEvent = createKeyEvent("v", { metaKey: true });
    expect(await tabs.handleKeyDown(pasteEvent)).toBeTrue();
    expect(pasteEvent.preventDefaultCount).toBe(1);
    expect(session.inputCalls).toContainEqual({ tabId: activeTabId, data: "pasted" });

    const searchEvent = createKeyEvent("f", { ctrlKey: true });
    expect(await tabs.handleKeyDown(searchEvent)).toBeTrue();
    expect(searchEvent.preventDefaultCount).toBe(1);
    expect(tabs.getSnapshot().search.isOpen).toBeTrue();
  });

  test("supports new/close/rename tab actions while preserving workspace ordering", async () => {
    const document = new FakeDocument();
    const paneHost = new FakeElement(document);
    const session = new FakeSessionAdapter();
    const tabs = new ShellTerminalTabs({
      terminalPaneHost: paneHost as unknown as HTMLElement,
      session,
      clipboard: new FakeClipboard(),
      viewFactory: new FakeViewFactory(),
    });

    await tabs.syncSidebarState({
      openWorkspaces: [
        { id: "ws_beta", absolutePath: "/beta", displayName: "Beta" },
        { id: "ws_alpha", absolutePath: "/alpha", displayName: "Alpha" },
      ],
      activeWorkspaceId: "ws_beta",
    });

    const initialSnapshot = tabs.getSnapshot();
    const initialBetaTabId = initialSnapshot.workspaces[0]!.tabs[0]!.tabId;

    const secondBetaTabId = await tabs.createTab("ws_beta");
    const thirdBetaTabId = await tabs.createTab("ws_beta");

    expect(secondBetaTabId).not.toBeNull();
    expect(thirdBetaTabId).not.toBeNull();
    expect(tabs.renameTab(secondBetaTabId!, "Build Logs")).toBeTrue();
    expect(tabs.renameTab(secondBetaTabId!, "   ")).toBeFalse();

    await tabs.closeTab(initialBetaTabId);

    const finalSnapshot = tabs.getSnapshot();
    expect(finalSnapshot.workspaceOrder).toEqual(["ws_beta", "ws_alpha"]);

    const betaWorkspace = finalSnapshot.workspaces[0]!;
    expect(betaWorkspace.tabs.map((tab) => tab.tabId)).toEqual([
      secondBetaTabId,
      thirdBetaTabId,
    ]);
    expect(betaWorkspace.tabs.map((tab) => tab.title)).toEqual(["Build Logs", "Terminal 3"]);
    expect(betaWorkspace.activeTabId).toBe(thirdBetaTabId);

    const renderedHtml = tabs.renderHtml();
    expect(renderedHtml).toContain('data-action="new-tab"');
    expect(renderedHtml).toContain('data-action="rename-tab"');
    expect(renderedHtml).toContain('data-action="close-tab"');
  });
});

function findPaneDisplay(paneHost: FakeElement, tabId: TerminalTabId): string | undefined {
  const pane = paneHost.children.find(
    (child) => child.getAttribute("data-terminal-tab-id") === tabId,
  );
  return pane?.style.display;
}

function createKeyEvent(
  key: string,
  flags: { metaKey?: boolean; ctrlKey?: boolean },
): ShellTerminalKeyEventLike & { preventDefaultCount: number } {
  return {
    key,
    metaKey: flags.metaKey,
    ctrlKey: flags.ctrlKey,
    preventDefaultCount: 0,
    preventDefault(): void {
      this.preventDefaultCount += 1;
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
