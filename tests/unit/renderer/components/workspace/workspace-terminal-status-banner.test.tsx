import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Children, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DeadTerminalBanner,
  shouldShowTerminalEndedBanner,
  TerminalViewLayout,
  terminalEndedMessage,
} from "../../../../../src/renderer/components/workspace/content/terminal-view";
import {
  requestReopenForDeadTerminalTabs,
  shouldShowWorkspaceTerminalStatusBanner,
  WorkspaceTerminalStatusBanner,
} from "../../../../../src/renderer/components/workspace/workspace-terminal-status-banner";
import {
  resetTerminalReopenRequestsForTests,
  subscribeTerminalReopenRequest,
} from "../../../../../src/renderer/services/terminal/reopen-requests";
import { type TerminalTab, useTabsStore } from "../../../../../src/renderer/state/stores/tabs";
import {
  configureTerminalDeathAggregationScheduler,
  useTerminalDeathStore,
} from "../../../../../src/renderer/state/stores/terminal-deaths";
import {
  selectIsWorkspaceOnline,
  useWorkspacesStore,
} from "../../../../../src/renderer/state/stores/workspaces";
import type { TimerScheduler } from "../../../../../src/shared/timer-scheduler";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";

const WS = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";

interface FakeScheduler extends TimerScheduler {
  tick: () => void;
}

/**
 * Creates a deterministic scheduler for the aggregate-window tests.
 */
function makeFakeScheduler(): FakeScheduler {
  type Entry = { callback: () => void; cancelled: boolean };
  const pending: Entry[] = [];
  return {
    setTimeout(callback) {
      const entry = { callback, cancelled: false };
      pending.push(entry);
      return entry;
    },
    clearTimeout(handle) {
      (handle as Entry).cancelled = true;
    },
    tick() {
      const entries = pending.splice(0);
      for (const entry of entries) {
        if (!entry.cancelled) entry.callback();
      }
    },
  };
}

/**
 * Builds the SSH workspace metadata used by aggregate banner copy.
 */
function sshWorkspace(): WorkspaceMeta {
  return {
    id: WS,
    name: "Workspace",
    location: {
      kind: "ssh",
      host: "devbox",
      user: "kih",
      remotePath: "/srv/workspace",
      authMode: "interactive",
    },
    rootPath: "/srv/workspace",
    colorTone: "default",
    pinned: false,
    tabs: [],
  };
}

/**
 * Resets the renderer stores touched by workspace terminal status tests.
 */
function resetStores(workspace: WorkspaceMeta): void {
  useTabsStore.setState({ byWorkspace: {} });
  useWorkspacesStore.setState({
    workspaces: [workspace],
    connectionStatusByWorkspaceId: {},
  });
  useTerminalDeathStore.getState().reset();
  resetTerminalReopenRequestsForTests();
}

/**
 * Creates one terminal tab record without involving layout placement.
 */
function createTerminal(cwd: string): TerminalTab {
  const tab = useTabsStore.getState().createTab(WS, {
    type: "terminal",
    props: { cwd },
  });
  if (tab.type !== "terminal") {
    throw new Error("expected terminal tab");
  }
  return tab;
}

/**
 * Invokes the banner's `Reopen all` button in a static React element.
 */
function clickReopenAll(element: ReactElement): void {
  const children = Children.toArray(element.props.children) as ReactElement[];
  const button = children.find((child) => child.type === "button");
  if (!button) throw new Error("Reopen all button not found");
  (button.props.onClick as () => void)();
}

describe("workspace terminal aggregate banner", () => {
  let restoreScheduler: (() => void) | null = null;
  let scheduler: FakeScheduler;

  beforeEach(() => {
    scheduler = makeFakeScheduler();
    restoreScheduler = configureTerminalDeathAggregationScheduler(scheduler);
    resetStores(sshWorkspace());
  });

  afterEach(() => {
    useTerminalDeathStore.getState().reset();
    restoreScheduler?.();
    restoreScheduler = null;
    resetTerminalReopenRequestsForTests();
  });

  test("groups three same-window terminal deaths into one workspace banner while per-tab banners remain visible", () => {
    const tabs = [createTerminal("/srv/a"), createTerminal("/srv/b"), createTerminal("/srv/c")];
    useWorkspacesStore.getState().setConnectionStatus(WS, "connected");

    for (const tab of tabs) {
      useTabsStore.getState().setTerminalDead(WS, tab.id, true);
    }
    expect(useTerminalDeathStore.getState().aggregateByWorkspaceId[WS]).toBeUndefined();

    scheduler.tick();

    const aggregate = useTerminalDeathStore.getState().aggregateByWorkspaceId[WS] ?? null;
    expect(aggregate?.tabIds).toHaveLength(3);
    expect(
      shouldShowWorkspaceTerminalStatusBanner({
        aggregate,
        deadTerminalCount: 3,
        workspaceOnline: selectIsWorkspaceOnline(useWorkspacesStore.getState(), WS),
      }),
    ).toBe(true);

    const bannerHtml = renderToStaticMarkup(
      <WorkspaceTerminalStatusBanner deadTerminalCount={3} onReopenAll={() => {}} />,
    );
    expect((bannerHtml.match(/role="status"/g) ?? []).length).toBe(1);
    expect(bannerHtml).toContain("3 terminals ended.");
    expect(bannerHtml).toContain("shrink-0 h-6");
    expect(bannerHtml).not.toContain("absolute");
    expect(bannerHtml).not.toContain("fixed");

    const perTabHtml = tabs
      .map(() =>
        renderToStaticMarkup(
          <TerminalViewLayout
            terminalEnded={true}
            banner={
              shouldShowTerminalEndedBanner(true, true) ? (
                <DeadTerminalBanner
                  message={terminalEndedMessage("idle")}
                  actionLabel="Reopen"
                  onReopen={() => {}}
                />
              ) : undefined
            }
          />,
        ),
      )
      .join("");
    expect((perTabHtml.match(/Terminal ended\./g) ?? []).length).toBe(3);
  });

  test("suppresses per-tab banners while offline and workspace banner is also hidden (offline affordance handles recovery)", () => {
    const tabs = [createTerminal("/srv/a"), createTerminal("/srv/b"), createTerminal("/srv/c")];
    useWorkspacesStore.getState().setConnectionStatus(WS, "idle");

    for (const tab of tabs) {
      useTabsStore.getState().setTerminalDead(WS, tab.id, true);
    }
    scheduler.tick();

    const aggregate = useTerminalDeathStore.getState().aggregateByWorkspaceId[WS] ?? null;
    expect(selectIsWorkspaceOnline(useWorkspacesStore.getState(), WS)).toBe(false);

    // H: workspace offline → our banner is suppressed regardless of dead count.
    // The workspace's own offline component is responsible for recovery.
    expect(
      shouldShowWorkspaceTerminalStatusBanner({
        aggregate,
        deadTerminalCount: 3,
        workspaceOnline: false,
      }),
    ).toBe(false);

    const offlineTabHtml = renderToStaticMarkup(
      <TerminalViewLayout
        terminalEnded={true}
        banner={
          shouldShowTerminalEndedBanner(true, false) ? (
            <DeadTerminalBanner
              message={terminalEndedMessage("idle")}
              actionLabel="Reopen"
              onReopen={() => {}}
            />
          ) : undefined
        }
      />,
    );
    expect(offlineTabHtml).not.toContain("Terminal ended.");
  });

  // H: offline state suppresses our banner for every dead-count value
  test("workspace offline: banner hidden for 1 dead terminal", () => {
    expect(
      shouldShowWorkspaceTerminalStatusBanner({
        aggregate: null,
        deadTerminalCount: 1,
        workspaceOnline: false,
      }),
    ).toBe(false);
  });

  test("workspace offline: banner hidden for 2 dead terminals", () => {
    expect(
      shouldShowWorkspaceTerminalStatusBanner({
        aggregate: { tabIds: ["t1", "t2"] },
        deadTerminalCount: 2,
        workspaceOnline: false,
      }),
    ).toBe(false);
  });

  test("workspace offline: banner hidden for 3 dead terminals", () => {
    expect(
      shouldShowWorkspaceTerminalStatusBanner({
        aggregate: { tabIds: ["t1", "t2", "t3"] },
        deadTerminalCount: 3,
        workspaceOnline: false,
      }),
    ).toBe(false);
  });

  test("Reopen all requests every dead terminal without changing tab id or cwd", () => {
    const first = createTerminal("/srv/first");
    const second = createTerminal("/srv/second");
    const live = createTerminal("/srv/live");
    useTabsStore.getState().setTerminalDead(WS, first.id, true);
    useTabsStore.getState().setTerminalDead(WS, second.id, true);

    const reopened: string[] = [];
    subscribeTerminalReopenRequest(WS, first.id, () => reopened.push(first.id));
    subscribeTerminalReopenRequest(WS, second.id, () => reopened.push(second.id));
    subscribeTerminalReopenRequest(WS, live.id, () => reopened.push(live.id));

    const element = WorkspaceTerminalStatusBanner({
      deadTerminalCount: 2,
      onReopenAll: () => {
        requestReopenForDeadTerminalTabs(WS, useTabsStore.getState().byWorkspace[WS] ?? {});
      },
    }) as ReactElement;

    clickReopenAll(element);

    expect(reopened).toEqual([first.id, second.id]);
    expect(useTabsStore.getState().byWorkspace[WS]?.[first.id]).toMatchObject({
      id: first.id,
      props: { cwd: "/srv/first", dead: true },
    });
    expect(useTabsStore.getState().byWorkspace[WS]?.[second.id]).toMatchObject({
      id: second.id,
      props: { cwd: "/srv/second", dead: true },
    });
  });

  // K: contrast regression guard for WorkspaceTerminalStatusBanner
  // app-status-banner-text must be present; text-muted-foreground must not
  // re-appear (it breaks contrast on the frosted-veil background).
  test("WorkspaceTerminalStatusBanner uses app-status-banner-text and does not use text-muted-foreground", () => {
    const html = renderToStaticMarkup(
      <WorkspaceTerminalStatusBanner deadTerminalCount={2} onReopenAll={() => {}} />,
    );

    expect(html).toContain("app-status-banner-text");
    expect(html).not.toContain("text-muted-foreground");
  });
});
