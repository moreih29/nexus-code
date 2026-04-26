import type { TerminalTabId } from "../../../shared/src/contracts/terminal-tab";
import type { WorkspaceSidebarState } from "../../../shared/src/contracts/workspace-shell";
import type { WorkspaceId } from "../../../shared/src/contracts/workspace";
import {
  XtermView,
  type XtermDisposable,
  type XtermResizeEvent,
  type XtermViewOptions,
} from "./xterm-view";

export interface ShellTerminalClipboard {
  readText(): Promise<string>;
  writeText(value: string): Promise<void>;
}

export interface ShellTerminalSessionAdapter {
  openTab(workspaceId: WorkspaceId): Promise<{ tabId: TerminalTabId }>;
  closeTab(tabId: TerminalTabId): Promise<void>;
  input(tabId: TerminalTabId, data: string): Promise<void>;
  resize(tabId: TerminalTabId, cols: number, rows: number): Promise<void>;
}

export interface ShellTerminalTabView {
  mount(container: HTMLElement | null | undefined): boolean;
  unmount(): void;
  fit(): void;
  focus(): void;
  write(data: string): void;
  searchNext(term: string): boolean;
  searchPrevious(term: string): boolean;
  hasSelection(): boolean;
  getSelection(): string;
  onSelectionChange(listener: () => void): XtermDisposable;
}

export interface ShellTerminalTabViewFactory {
  create(options: ShellTerminalTabViewCreateOptions): ShellTerminalTabView;
}

export interface ShellTerminalTabViewCreateOptions extends XtermViewOptions {
  tabId: TerminalTabId;
  workspaceId: WorkspaceId;
}

export interface ShellTerminalKeyEventLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  preventDefault?(): void;
}

export interface ShellTerminalTabSnapshot {
  tabId: TerminalTabId;
  workspaceId: WorkspaceId;
  title: string;
  isActive: boolean;
  isVisible: boolean;
}

export interface ShellTerminalWorkspaceSnapshot {
  workspaceId: WorkspaceId;
  displayName: string;
  isActiveWorkspace: boolean;
  activeTabId: TerminalTabId | null;
  tabs: ShellTerminalTabSnapshot[];
}

export interface ShellTerminalSearchState {
  isOpen: boolean;
  query: string;
  noMoreMatches: boolean;
  statusMessage: string | null;
}

export interface ShellTerminalTabsSnapshot {
  workspaceOrder: WorkspaceId[];
  activeWorkspaceId: WorkspaceId | null;
  workspaces: ShellTerminalWorkspaceSnapshot[];
  search: ShellTerminalSearchState;
}

export interface ShellTerminalTabsOptions {
  terminalPaneHost: HTMLElement;
  session: ShellTerminalSessionAdapter;
  clipboard: ShellTerminalClipboard;
  viewFactory?: ShellTerminalTabViewFactory;
  createTabTitle?: (workspaceId: WorkspaceId, nextIndex: number) => string;
}

interface ShellTerminalTabRecord {
  tabId: TerminalTabId;
  workspaceId: WorkspaceId;
  title: string;
  container: HTMLElement;
  view: ShellTerminalTabView;
  selectionDisposable: XtermDisposable;
  focusEventDisposable: XtermDisposable;
}

const DEFAULT_VIEW_FACTORY: ShellTerminalTabViewFactory = {
  create: ({ tabId: _tabId, workspaceId: _workspaceId, ...viewOptions }) =>
    new XtermView(viewOptions),
};

const NO_MORE_MATCHES_MESSAGE = "No more matches";

export class ShellTerminalTabs {
  private readonly viewFactory: ShellTerminalTabViewFactory;
  private readonly createTabTitle: (workspaceId: WorkspaceId, nextIndex: number) => string;

  private workspaceOrder: WorkspaceId[] = [];
  private activeWorkspaceId: WorkspaceId | null = null;

  private readonly workspaceDisplayNameById = new Map<WorkspaceId, string>();
  private readonly tabOrderByWorkspaceId = new Map<WorkspaceId, TerminalTabId[]>();
  private readonly activeTabByWorkspaceId = new Map<WorkspaceId, TerminalTabId | null>();
  private readonly nextTabIndexByWorkspaceId = new Map<WorkspaceId, number>();
  private readonly tabRecordsById = new Map<TerminalTabId, ShellTerminalTabRecord>();
  private readonly visibleByTabId = new Map<TerminalTabId, boolean>();

  private readonly searchState: ShellTerminalSearchState = {
    isOpen: false,
    query: "",
    noMoreMatches: false,
    statusMessage: null,
  };

  public constructor(private readonly options: ShellTerminalTabsOptions) {
    this.viewFactory = options.viewFactory ?? DEFAULT_VIEW_FACTORY;
    this.createTabTitle =
      options.createTabTitle ??
      ((_workspaceId: WorkspaceId, nextIndex: number) => `Terminal ${nextIndex}`);
  }

  public async syncSidebarState(sidebarState: WorkspaceSidebarState): Promise<void> {
    const nextWorkspaceOrder = sidebarState.openWorkspaces.map((workspace) => workspace.id);
    const nextWorkspaceIdSet = new Set(nextWorkspaceOrder);

    for (const existingWorkspaceId of this.workspaceOrder) {
      if (!nextWorkspaceIdSet.has(existingWorkspaceId)) {
        this.disposeWorkspace(existingWorkspaceId);
      }
    }

    this.workspaceOrder = nextWorkspaceOrder;
    this.activeWorkspaceId = sidebarState.activeWorkspaceId;

    for (const workspace of sidebarState.openWorkspaces) {
      this.workspaceDisplayNameById.set(workspace.id, workspace.displayName);
      if (!this.tabOrderByWorkspaceId.has(workspace.id)) {
        this.tabOrderByWorkspaceId.set(workspace.id, []);
      }
      if (!this.activeTabByWorkspaceId.has(workspace.id)) {
        this.activeTabByWorkspaceId.set(workspace.id, null);
      }
      if (!this.nextTabIndexByWorkspaceId.has(workspace.id)) {
        this.nextTabIndexByWorkspaceId.set(workspace.id, 1);
      }
    }

    if (this.activeWorkspaceId && !nextWorkspaceIdSet.has(this.activeWorkspaceId)) {
      this.activeWorkspaceId = this.workspaceOrder[0] ?? null;
    }
    if (!this.activeWorkspaceId) {
      this.activeWorkspaceId = this.workspaceOrder[0] ?? null;
    }

    const requestedActiveWorkspaceId = this.activeWorkspaceId;
    for (const workspaceId of this.workspaceOrder) {
      if ((this.tabOrderByWorkspaceId.get(workspaceId)?.length ?? 0) === 0) {
        await this.createTab(workspaceId, workspaceId === requestedActiveWorkspaceId);
      }
      this.ensureWorkspaceActiveTab(workspaceId);
    }

    if (requestedActiveWorkspaceId && this.tabOrderByWorkspaceId.has(requestedActiveWorkspaceId)) {
      this.activeWorkspaceId = requestedActiveWorkspaceId;
    }

    this.applyVisibility();
  }

  public getSnapshot(): ShellTerminalTabsSnapshot {
    const workspaces = this.workspaceOrder.map((workspaceId) => {
      const activeTabId = this.activeTabByWorkspaceId.get(workspaceId) ?? null;
      const tabs = (this.tabOrderByWorkspaceId.get(workspaceId) ?? [])
        .map((tabId) => {
          const record = this.tabRecordsById.get(tabId);
          if (!record) {
            return null;
          }

          return {
            tabId,
            workspaceId,
            title: record.title,
            isActive: activeTabId === tabId,
            isVisible: this.visibleByTabId.get(tabId) ?? false,
          };
        })
        .filter((tab): tab is ShellTerminalTabSnapshot => tab !== null);

      return {
        workspaceId,
        displayName: this.workspaceDisplayNameById.get(workspaceId) ?? workspaceId,
        isActiveWorkspace: workspaceId === this.activeWorkspaceId,
        activeTabId,
        tabs,
      };
    });

    return {
      workspaceOrder: [...this.workspaceOrder],
      activeWorkspaceId: this.activeWorkspaceId,
      workspaces,
      search: {
        ...this.searchState,
      },
    };
  }

  public renderHtml(): string {
    return renderShellTerminalTabsHtml(this.getSnapshot());
  }

  public async createTab(
    workspaceId = this.activeWorkspaceId,
    activateTab = true,
  ): Promise<TerminalTabId | null> {
    if (!workspaceId || !this.tabOrderByWorkspaceId.has(workspaceId)) {
      return null;
    }

    const opened = await this.options.session.openTab(workspaceId);
    this.registerOpenedTab(workspaceId, opened.tabId, activateTab);
    this.applyVisibility();
    return opened.tabId;
  }

  public registerOpenedTab(
    workspaceId: WorkspaceId,
    tabId: TerminalTabId,
    activateTab = true,
  ): void {
    if (!this.tabOrderByWorkspaceId.has(workspaceId)) {
      this.workspaceOrder.push(workspaceId);
      this.workspaceDisplayNameById.set(workspaceId, workspaceId);
      this.tabOrderByWorkspaceId.set(workspaceId, []);
      this.activeTabByWorkspaceId.set(workspaceId, null);
      this.nextTabIndexByWorkspaceId.set(workspaceId, 1);
      if (!this.activeWorkspaceId) {
        this.activeWorkspaceId = workspaceId;
      }
    }

    if (this.tabRecordsById.has(tabId)) {
      return;
    }

    const nextTabIndex = this.nextTabIndexByWorkspaceId.get(workspaceId) ?? 1;
    this.nextTabIndexByWorkspaceId.set(workspaceId, nextTabIndex + 1);

    const container = this.createTerminalContainer(tabId);
    this.appendPaneContainer(container);

    const view = this.viewFactory.create({
      tabId,
      workspaceId,
      onInput: (data) => {
        void this.options.session.input(tabId, data).catch(() => {
          // no-op
        });
      },
      onResize: (size: XtermResizeEvent) => {
        void this.options.session.resize(tabId, size.cols, size.rows).catch(() => {
          // no-op
        });
      },
    });

    view.mount(container);
    const focusEventDisposable = this.installFocusOnPointer(container, view);

    const selectionDisposable = view.onSelectionChange(() => {
      void this.copySelectionForTab(tabId).catch(() => {
        // no-op
      });
    });

    const record: ShellTerminalTabRecord = {
      tabId,
      workspaceId,
      title: this.createTabTitle(workspaceId, nextTabIndex),
      container,
      view,
      selectionDisposable,
      focusEventDisposable,
    };
    this.tabRecordsById.set(tabId, record);

    const tabOrder = this.tabOrderByWorkspaceId.get(workspaceId) ?? [];
    tabOrder.push(tabId);
    this.tabOrderByWorkspaceId.set(workspaceId, tabOrder);

    const activeTabId = this.activeTabByWorkspaceId.get(workspaceId);
    if (!activeTabId) {
      this.activeTabByWorkspaceId.set(workspaceId, tabId);
    }
    if (activateTab) {
      this.activeTabByWorkspaceId.set(workspaceId, tabId);
      this.activeWorkspaceId = workspaceId;
    }

    this.visibleByTabId.set(tabId, false);
  }

  public fitActiveTab(): boolean {
    const record = this.getActiveTabRecord();
    if (!record || !(this.visibleByTabId.get(record.tabId) ?? false)) {
      return false;
    }

    record.view.fit();
    this.scheduleVisibleTabRenderRepair(record.tabId);
    return true;
  }

  public async closeTab(tabId: TerminalTabId): Promise<void> {
    if (!this.tabRecordsById.has(tabId)) {
      return;
    }

    await this.options.session.closeTab(tabId);
    this.disposeTab(tabId);
    this.applyVisibility();
  }

  public handleTabExited(tabId: TerminalTabId): void {
    if (!this.tabRecordsById.has(tabId)) {
      return;
    }

    this.disposeTab(tabId);
    this.applyVisibility();
  }

  public renameTab(tabId: TerminalTabId, nextTitle: string): boolean {
    const record = this.tabRecordsById.get(tabId);
    if (!record) {
      return false;
    }

    const normalizedTitle = nextTitle.trim();
    if (normalizedTitle.length === 0) {
      return false;
    }

    record.title = normalizedTitle;
    return true;
  }

  public activateWorkspace(workspaceId: WorkspaceId): void {
    if (!this.tabOrderByWorkspaceId.has(workspaceId)) {
      return;
    }

    this.activeWorkspaceId = workspaceId;
    this.ensureWorkspaceActiveTab(workspaceId);
    this.applyVisibility();
  }

  public activateTab(tabId: TerminalTabId): void {
    const record = this.tabRecordsById.get(tabId);
    if (!record) {
      return;
    }

    this.activeWorkspaceId = record.workspaceId;
    this.activeTabByWorkspaceId.set(record.workspaceId, tabId);
    this.applyVisibility();
  }

  public writeToTab(tabId: TerminalTabId, data: string): void {
    this.tabRecordsById.get(tabId)?.view.write(data);
  }

  public openSearchBar(): void {
    this.searchState.isOpen = true;
    this.resetSearchBoundary();
  }

  public closeSearchBar(): void {
    this.searchState.isOpen = false;
    this.resetSearchBoundary();
  }

  public setSearchQuery(query: string): void {
    this.searchState.query = query;
    this.resetSearchBoundary();
  }

  public searchNext(): boolean {
    return this.runSearch("next");
  }

  public searchPrevious(): boolean {
    return this.runSearch("previous");
  }

  public async copyActiveSelection(): Promise<boolean> {
    const activeTabId = this.getActiveTabId();
    if (!activeTabId) {
      return false;
    }

    return this.copySelectionForTab(activeTabId);
  }

  public async pasteFromClipboard(): Promise<boolean> {
    const activeTabId = this.getActiveTabId();
    if (!activeTabId) {
      return false;
    }

    const clipboardText = await this.options.clipboard.readText();
    if (clipboardText.length === 0) {
      return true;
    }

    await this.options.session.input(activeTabId, clipboardText);
    return true;
  }

  public async handleKeyDown(event: ShellTerminalKeyEventLike): Promise<boolean> {
    if (!isPrimaryModifierPressed(event)) {
      return false;
    }

    const normalizedKey = event.key.toLowerCase();
    if (normalizedKey === "f") {
      event.preventDefault?.();
      this.openSearchBar();
      return true;
    }
    if (normalizedKey === "c") {
      const didCopy = await this.copyActiveSelection();
      if (didCopy) {
        event.preventDefault?.();
      }
      return didCopy;
    }
    if (normalizedKey === "v") {
      const didPaste = await this.pasteFromClipboard();
      if (didPaste) {
        event.preventDefault?.();
      }
      return didPaste;
    }

    return false;
  }

  public dispose(): void {
    for (const workspaceId of [...this.workspaceOrder]) {
      this.disposeWorkspace(workspaceId);
    }

    this.workspaceOrder = [];
    this.activeWorkspaceId = null;
    this.workspaceDisplayNameById.clear();
    this.tabOrderByWorkspaceId.clear();
    this.activeTabByWorkspaceId.clear();
    this.nextTabIndexByWorkspaceId.clear();
    this.tabRecordsById.clear();
    this.visibleByTabId.clear();
    this.closeSearchBar();
  }

  private async copySelectionForTab(tabId: TerminalTabId): Promise<boolean> {
    const record = this.tabRecordsById.get(tabId);
    if (!record || !record.view.hasSelection()) {
      return false;
    }

    const selectedText = record.view.getSelection();
    if (selectedText.length === 0) {
      return false;
    }

    await this.options.clipboard.writeText(selectedText);
    return true;
  }

  private runSearch(direction: "next" | "previous"): boolean {
    const record = this.getActiveTabRecord();
    const query = this.searchState.query;
    if (!record || query.length === 0) {
      this.resetSearchBoundary();
      return false;
    }

    const found = direction === "next" ? record.view.searchNext(query) : record.view.searchPrevious(query);
    if (found) {
      this.resetSearchBoundary();
      return true;
    }

    this.searchState.noMoreMatches = true;
    this.searchState.statusMessage = NO_MORE_MATCHES_MESSAGE;
    return false;
  }

  private resetSearchBoundary(): void {
    this.searchState.noMoreMatches = false;
    this.searchState.statusMessage = null;
  }

  private disposeWorkspace(workspaceId: WorkspaceId): void {
    const tabIds = [...(this.tabOrderByWorkspaceId.get(workspaceId) ?? [])];
    for (const tabId of tabIds) {
      this.disposeTab(tabId);
    }

    this.tabOrderByWorkspaceId.delete(workspaceId);
    this.activeTabByWorkspaceId.delete(workspaceId);
    this.nextTabIndexByWorkspaceId.delete(workspaceId);
    this.workspaceDisplayNameById.delete(workspaceId);

    this.workspaceOrder = this.workspaceOrder.filter((candidateWorkspaceId) => candidateWorkspaceId !== workspaceId);
    if (this.activeWorkspaceId === workspaceId) {
      this.activeWorkspaceId = this.workspaceOrder[0] ?? null;
    }
  }

  private disposeTab(tabId: TerminalTabId): void {
    const record = this.tabRecordsById.get(tabId);
    if (!record) {
      return;
    }

    record.selectionDisposable.dispose();
    record.focusEventDisposable.dispose();
    record.view.unmount();
    this.removePaneContainer(record.container);

    this.tabRecordsById.delete(tabId);
    this.visibleByTabId.delete(tabId);

    const tabOrder = this.tabOrderByWorkspaceId.get(record.workspaceId) ?? [];
    const nextTabOrder = tabOrder.filter((candidateTabId) => candidateTabId !== tabId);
    this.tabOrderByWorkspaceId.set(record.workspaceId, nextTabOrder);

    const activeTabId = this.activeTabByWorkspaceId.get(record.workspaceId);
    if (activeTabId === tabId) {
      this.activeTabByWorkspaceId.set(record.workspaceId, nextTabOrder[0] ?? null);
    }
  }

  private ensureWorkspaceActiveTab(workspaceId: WorkspaceId): void {
    const tabOrder = this.tabOrderByWorkspaceId.get(workspaceId) ?? [];
    const activeTabId = this.activeTabByWorkspaceId.get(workspaceId);

    if (activeTabId && tabOrder.includes(activeTabId)) {
      return;
    }

    this.activeTabByWorkspaceId.set(workspaceId, tabOrder[0] ?? null);
  }

  private getActiveTabId(): TerminalTabId | null {
    if (!this.activeWorkspaceId) {
      return null;
    }

    return this.activeTabByWorkspaceId.get(this.activeWorkspaceId) ?? null;
  }

  private getActiveTabRecord(): ShellTerminalTabRecord | null {
    const activeTabId = this.getActiveTabId();
    if (!activeTabId) {
      return null;
    }

    return this.tabRecordsById.get(activeTabId) ?? null;
  }

  private applyVisibility(): void {
    for (const [tabId, record] of this.tabRecordsById) {
      const shouldBeVisible =
        record.workspaceId === this.activeWorkspaceId &&
        this.activeTabByWorkspaceId.get(record.workspaceId) === tabId;
      this.setTabVisibility(record, shouldBeVisible);
    }
  }

  private setTabVisibility(record: ShellTerminalTabRecord, isVisible: boolean): void {
    const wasVisible = this.visibleByTabId.get(record.tabId) ?? false;

    (record.container as { style?: { display?: string } }).style ??= {};
    (record.container as { style: { display?: string } }).style.display = isVisible ? "" : "none";
    this.visibleByTabId.set(record.tabId, isVisible);

    if (isVisible && !wasVisible) {
      record.view.fit();
      this.scheduleVisibleTabRenderRepair(record.tabId);
      record.view.focus();
    }
  }

  private scheduleVisibleTabRenderRepair(tabId: TerminalTabId): void {
    const record = this.tabRecordsById.get(tabId);
    const viewWindow = record?.container.ownerDocument?.defaultView;
    if (!record || !viewWindow) {
      return;
    }

    viewWindow.requestAnimationFrame(() => {
      const latestRecord = this.tabRecordsById.get(tabId);
      if (!latestRecord || !(this.visibleByTabId.get(tabId) ?? false)) {
        return;
      }

      latestRecord.view.fit();
    });
  }

  private installFocusOnPointer(
    container: HTMLElement,
    view: ShellTerminalTabView,
  ): XtermDisposable {
    const eventTarget = container as {
      addEventListener?: (type: string, listener: EventListener) => void;
      removeEventListener?: (type: string, listener: EventListener) => void;
    };
    const focusView = (): void => {
      view.focus();
    };

    eventTarget.addEventListener?.("mousedown", focusView);

    return {
      dispose: () => {
        eventTarget.removeEventListener?.("mousedown", focusView);
      },
    };
  }

  private createTerminalContainer(tabId: TerminalTabId): HTMLElement {
    const ownerDocument = (this.options.terminalPaneHost as { ownerDocument?: { createElement?: (tagName: string) => unknown } })
      .ownerDocument;
    const container =
      (ownerDocument?.createElement?.("div") as HTMLElement | undefined) ??
      ({ style: {} } as unknown as HTMLElement);

    (container as { style?: { display?: string; width?: string; height?: string; overflow?: string } }).style ??= {};
    const containerStyle = (container as {
      style: { display?: string; width?: string; height?: string; overflow?: string };
    }).style;
    containerStyle.display = "none";
    containerStyle.width = "100%";
    containerStyle.height = "100%";
    containerStyle.overflow = "hidden";
    (container as { setAttribute?: (name: string, value: string) => void }).setAttribute?.(
      "data-terminal-tab-id",
      tabId,
    );

    return container;
  }

  private appendPaneContainer(container: HTMLElement): void {
    (this.options.terminalPaneHost as { appendChild?: (child: unknown) => void }).appendChild?.(container);
  }

  private removePaneContainer(container: HTMLElement): void {
    (this.options.terminalPaneHost as { removeChild?: (child: unknown) => void }).removeChild?.(container);
  }
}

export function renderShellTerminalTabsHtml(snapshot: ShellTerminalTabsSnapshot): string {
  const workspaceHtml = snapshot.workspaces
    .map((workspace) => {
      const tabsHtml = workspace.tabs
        .map((tab) => {
          return [
            "<li>",
            `<button type=\"button\" data-action=\"activate-tab\" data-tab-id=\"${escapeHtmlAttribute(
              tab.tabId,
            )}\" data-active=\"${tab.isActive ? "true" : "false"}\">${escapeHtmlText(tab.title)}</button>`,
            `<button type=\"button\" data-action=\"rename-tab\" data-tab-id=\"${escapeHtmlAttribute(
              tab.tabId,
            )}\">Rename</button>`,
            `<button type=\"button\" data-action=\"close-tab\" data-tab-id=\"${escapeHtmlAttribute(
              tab.tabId,
            )}\">×</button>`,
            "</li>",
          ].join("");
        })
        .join("");

      return [
        `<section data-workspace-id=\"${escapeHtmlAttribute(workspace.workspaceId)}\" data-active-workspace=\"${
          workspace.isActiveWorkspace ? "true" : "false"
        }\">`,
        "<header>",
        `<h3>${escapeHtmlText(workspace.displayName)}</h3>`,
        `<button type=\"button\" data-action=\"new-tab\" data-workspace-id=\"${escapeHtmlAttribute(
          workspace.workspaceId,
        )}\">+</button>`,
        "</header>",
        `<ol>${tabsHtml}</ol>`,
        "</section>",
      ].join("");
    })
    .join("");

  const searchDisplay = snapshot.search.isOpen ? "" : "none";

  return [
    '<section data-component="shell-terminal-tabs">',
    `<div data-slot=\"tab-header\">${workspaceHtml}</div>`,
    `<div data-slot=\"search-bar\" style=\"display:${searchDisplay};\">`,
    `<input type=\"search\" data-role=\"search-input\" value=\"${escapeHtmlAttribute(
      snapshot.search.query,
    )}\" />`,
    '<button type="button" data-action="search-previous">↑</button>',
    '<button type="button" data-action="search-next">↓</button>',
    `<span data-role=\"search-status\">${escapeHtmlText(snapshot.search.statusMessage ?? "")}</span>`,
    "</div>",
    "</section>",
  ].join("");
}

function isPrimaryModifierPressed(event: ShellTerminalKeyEventLike): boolean {
  return event.metaKey === true || event.ctrlKey === true;
}

function escapeHtmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replaceAll('"', "&quot;");
}
