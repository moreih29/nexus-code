/**
 * Browser IPC event subscriptions — main → renderer wiring.
 *
 * Subscribes to the four `browser.*` broadcast events that main sends when
 * WebContents lifecycle events fire.  Each event updates the corresponding
 * entry in `useBrowserRuntimeStore`.
 *
 * INITIALIZATION
 * --------------
 * Call `initBrowserRuntimeSubscriptions()` once during app bootstrap (after
 * the IPC bridge is installed).  The function is idempotent — a second call
 * unsubscribes the previous listeners and installs fresh ones (safe for HMR
 * during development).
 *
 * TAB DESTROY CLEANUP
 * -------------------
 * `useBrowserRuntimeStore.getState().removeRuntime(tabId)` should be called
 * by any renderer-side code that sends `browser.destroy` to main, since
 * destroy is renderer-initiated and no separate event is broadcast back.
 *
 * EVENT → STORE MAPPING
 * ---------------------
 * - browser:navigated     → setRuntime(tabId, { currentUrl, canGoBack, canGoForward })
 * - browser:loadingChanged → setRuntime(tabId, { isLoading })
 * - browser:loadFailureChanged → set or clear the tab's failure
 * - browser:titleUpdated   → setRuntime(tabId, { title })
 *
 */

import i18next from "i18next";
import { Grid } from "@/engine";
import { loopbackPort } from "../../../shared/pty/ports";
import { isNavigationSchemeAllowed } from "../../../shared/security/navigation-allowlist";
import { showToast } from "../../components/ui/toast";
import { ipcListen } from "../../ipc/client";
import type { ListenArg, ListenEvents } from "../../ipc/types";
import { useBrowserRuntimeStore } from "../stores/browser-runtime";
import { useLayoutStore } from "../stores/layout/store";
import type { BrowserTabProps } from "../stores/tabs";
import { useTabsStore } from "../stores/tabs";
import { showForwardFailure } from "./ports";

// ---------------------------------------------------------------------------
// IPC subscriptions
// ---------------------------------------------------------------------------

const browserViews = new Map<string, { workspaceId: string; viewId: string }>();

/** Start a renderer-owned generation before requesting its native view. */
export function beginBrowserView(workspaceId: string, tabId: string): string {
  const viewId = crypto.randomUUID();
  browserViews.set(tabId, { workspaceId, viewId });
  return viewId;
}

/** Drop the runtime when its view goes away, even if IPC replies are still queued. */
export function endBrowserView(tabId: string, viewId: string): void {
  if (browserViews.get(tabId)?.viewId !== viewId) return;
  browserViews.delete(tabId);
  useBrowserRuntimeStore.getState().removeRuntime(tabId);
}

/** Deliver page events only to the mounted view that requested this generation. */
function listenToView<E extends Exclude<ListenEvents<"browser">, "downloaded">>(
  event: E,
  receive: (payload: ListenArg<"browser", E>, workspaceId: string) => void,
): () => void {
  return ipcListen("browser", event, (payload) => {
    const view = browserViews.get(payload.tabId);
    if (!view || view.viewId !== payload.viewId) return;
    const tab = useTabsStore.getState().byWorkspace[view.workspaceId]?.[payload.tabId];
    if (tab?.type === "browser") receive(payload, view.workspaceId);
  });
}

type Unsubscribe = () => void;

let activeUnsubs: Unsubscribe[] = [];

/**
 * Install (or reinstall) the browser event → runtime store subscriptions.
 *
 * Safe to call multiple times — previous listeners are removed first.
 */
export function initBrowserRuntimeSubscriptions(): void {
  // Remove any previously installed listeners (supports HMR / test isolation).
  for (const unsub of activeUnsubs) {
    unsub();
  }
  activeUnsubs = [];

  activeUnsubs.push(
    listenToView("navigated", ({ tabId, url, canGoBack, canGoForward }, workspaceId) => {
      useBrowserRuntimeStore.getState().setRuntime(tabId, {
        currentUrl: url,
        canGoBack,
        canGoForward,
      });
      // Capture the committed URL before layout persistence takes its snapshot.
      useTabsStore.getState().setBrowserLastUrl(workspaceId, tabId, url);
    }),
  );

  activeUnsubs.push(
    listenToView("loadingChanged", ({ tabId, isLoading }) => {
      useBrowserRuntimeStore.getState().setRuntime(tabId, { isLoading });
    }),
  );

  activeUnsubs.push(
    listenToView("loadFailureChanged", ({ tabId, failure }) => {
      useBrowserRuntimeStore.getState().setRuntime(tabId, {
        loadFailure: failure,
        ...(failure ? { isLoading: false } : {}),
      });
    }),
  );

  // A local address of an SSH workspace whose port could not be forwarded.
  activeUnsubs.push(
    listenToView("refused", ({ url, kind, message }, workspaceId) => {
      showForwardFailure(workspaceId, loopbackPort(url) ?? 0, kind, message);
    }),
  );

  activeUnsubs.push(
    listenToView("titleUpdated", ({ tabId, title }, workspaceId) => {
      useBrowserRuntimeStore.getState().setRuntime(tabId, { title });
      // Sync processTitle onto the tab too — so the tab name follows the page title like Chrome.
      // If the user set customTitle via renameTab, the display stays as is.
      useTabsStore.getState().setProcessTitle(workspaceId, tabId, title);
    }),
  );

  // page-favicon-updated → browser-runtime store. Uses only the first entry of the candidate array.
  // If null or an empty array, faviconUrl is cleared so TabItem returns to the default Globe icon.
  activeUnsubs.push(
    listenToView("faviconUpdated", ({ tabId, favicons }) => {
      const next = favicons && favicons.length > 0 ? favicons[0] : null;
      useBrowserRuntimeStore.getState().setRuntime(tabId, { faviconUrl: next });
    }),
  );

  // Hide-and-screenshot pattern: main captures a JPEG of the page before
  // calling `setVisible(false)` and broadcasts it here.  The renderer paints
  // the dataURL as an absolute overlay over the placeholder so a freshly
  // opened modal sees a still frame rather than a blank area.  The matching
  // `cleared` event clears the cache when the modal closes and the native
  // view is shown again.
  activeUnsubs.push(
    listenToView("snapshot", (payload) => {
      if (payload.kind === "set") {
        useBrowserRuntimeStore.getState().setRuntime(payload.tabId, { snapshot: payload.dataUrl });
      } else {
        useBrowserRuntimeStore.getState().setRuntime(payload.tabId, { snapshot: null });
      }
    }),
  );

  // DevTools toggle broadcast — drives the inline split layout.  When `open`
  // becomes true the renderer mounts its DevTools region and starts a
  // ResizeObserver that sends `setDevToolsBounds`; when it returns to false
  // the region unmounts and the page region reclaims the full content area.
  activeUnsubs.push(
    listenToView("devtoolsToggled", ({ tabId, open }) => {
      useBrowserRuntimeStore.getState().setRuntime(tabId, { devtoolsOpen: open });
    }),
  );

  // focus: the WebContentsView is a native view outside the DOM event chain,
  // so a click on the page never reaches GroupView's focusin/mousedown
  // listeners. Main broadcasts this when the page gains focus; we activate the
  // group that owns the tab so clicking a browser panel behaves like clicking
  // any other panel.
  activeUnsubs.push(
    listenToView("focused", ({ tabId }) => {
      activateGroupForTab(tabId);
    }),
  );

  // focusUrl: the browser.focusUrl shortcut (⌘L) fired while the page had
  // focus, so it was caught by the main key interceptor and bounced here —
  // focus the address bar for that tab (mirrors the in-renderer command).
  activeUnsubs.push(
    listenToView("focusUrl", ({ tabId }) => {
      useBrowserRuntimeStore.getState().requestUrlFocus(tabId);
    }),
  );

  // downloaded: a download the user started in a tab is done. It is saved
  // without asking, so the user is told it came.
  activeUnsubs.push(
    ipcListen("browser", "downloaded", ({ file }) => {
      showToast({ kind: "info", message: i18next.t("common:browser.downloaded", { file }) });
    }),
  );
}

/**
 * Activate the layout group that owns `tabId`.
 *
 * Resolves the workspace via the tabs store, locates the leaf whose `tabIds`
 * contains `tabId`, and calls `setActiveGroup`. No-ops when the tab is not
 * found or its group is already active (the store also early-returns on a
 * redundant activation, so this is cheap to call on every focus event).
 *
 * Exported for unit testing — the production caller is the `browser:focused`
 * IPC subscription above.
 */
export function activateGroupForTab(tabId: string): void {
  const workspaceId = findWorkspaceForTab(tabId);
  if (!workspaceId) return;
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) return;
  const owner = Grid.allLeaves(layout.root).find((leaf) => leaf.tabIds.includes(tabId));
  if (!owner || layout.activeGroupId === owner.id) return;
  useLayoutStore.getState().setActiveGroup(workspaceId, owner.id);
}

/**
 * Resolve the workspaceId that owns `tabId` by scanning the tabs store.
 * Returns `undefined` when no workspace has an entry for `tabId`.
 */
function findWorkspaceForTab(tabId: string): string | undefined {
  const byWorkspace = useTabsStore.getState().byWorkspace;
  for (const [workspaceId, tabRecord] of Object.entries(byWorkspace)) {
    if (tabId in tabRecord) return workspaceId;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// BrowserTabView helper — restore URL on workspace re-entry
// ---------------------------------------------------------------------------

/**
 * Resolve the URL that a BrowserTabView should navigate to on mount.
 *
 * Algorithm:
 * 1. If `props.lastUrl` is non-empty and passes `isNavigationSchemeAllowed`,
 *    return it — this is the last URL the user visited.
 * 2. Otherwise return `null` — the caller should render an empty / blank
 *    state rather than loading `initialUrl`, per the plan decision that
 *    `initialUrl` is not a fallback for a failed `lastUrl` validation.
 *
 * Only `http:` and `https:` schemes are considered safe for in-frame loading
 * (see `navigation-allowlist.ts`).
 *
 * @param props - The `BrowserTab.props` from the tabs store (or persistence).
 * @returns The URL string to load, or `null` if the tab should start blank.
 */
export function resolveInitialBrowserUrl(props: BrowserTabProps): string | null {
  if (props.lastUrl && isNavigationSchemeAllowed(props.lastUrl)) {
    return props.lastUrl;
  }
  return null;
}
