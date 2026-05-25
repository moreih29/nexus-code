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
 * - browser:error          → setRuntime(tabId, { isLoading: false })
 * - browser:titleUpdated   → setRuntime(tabId, { title })
 *
 * LAST-URL PERSISTENCE
 * --------------------
 * A `useBrowserRuntimeStore` zustand subscription watches `currentUrl`
 * changes for every tracked tab.  Changes are debounced 250 ms per tab via
 * `createKeyedDebouncer`, then dispatched to `setBrowserLastUrl` in the tabs
 * store so the URL survives app restarts.
 *
 * `initBrowserLastUrlPersistence()` must be called after
 * `initBrowserRuntimeSubscriptions()` during bootstrap.  It is also
 * idempotent — a second call tears down the previous subscription.
 */

import { ipcListen } from "../../ipc/client";
import { useBrowserRuntimeStore } from "../stores/browser-runtime";
import { useTabsStore } from "../stores/tabs";
import { isNavigationSchemeAllowed } from "../../../shared/security/navigation-allowlist";
import { createKeyedDebouncer } from "../../../shared/util/keyed-debouncer";
import { BROWSER_LAST_URL_SAVE_DEBOUNCE_MS } from "../../../shared/util/timing-constants";
import type { TimerScheduler } from "../../../shared/util/timer-scheduler";
import type { BrowserTabProps } from "../stores/tabs";

// ---------------------------------------------------------------------------
// IPC subscriptions
// ---------------------------------------------------------------------------

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
    ipcListen("browser", "navigated", ({ tabId, url, canGoBack, canGoForward }) => {
      useBrowserRuntimeStore.getState().setRuntime(tabId, {
        currentUrl: url,
        canGoBack,
        canGoForward,
      });
    }),
  );

  activeUnsubs.push(
    ipcListen("browser", "loadingChanged", ({ tabId, isLoading }) => {
      useBrowserRuntimeStore.getState().setRuntime(tabId, { isLoading });
    }),
  );

  activeUnsubs.push(
    ipcListen("browser", "error", ({ tabId }) => {
      // did-fail-load implies loading has ended.
      useBrowserRuntimeStore.getState().setRuntime(tabId, { isLoading: false });
    }),
  );

  activeUnsubs.push(
    ipcListen("browser", "titleUpdated", ({ tabId, title }) => {
      useBrowserRuntimeStore.getState().setRuntime(tabId, { title });
    }),
  );

  // Hide-and-screenshot pattern: main captures a JPEG of the page before
  // calling `setVisible(false)` and broadcasts it here.  The renderer paints
  // the dataURL as an absolute overlay over the placeholder so a freshly
  // opened modal sees a still frame rather than a blank area.  The matching
  // `cleared` event clears the cache when the modal closes and the native
  // view is shown again.
  activeUnsubs.push(
    ipcListen("browser", "snapshot", (payload) => {
      if (payload.kind === "set") {
        useBrowserRuntimeStore
          .getState()
          .setRuntime(payload.tabId, { snapshot: payload.dataUrl });
      } else {
        useBrowserRuntimeStore.getState().setRuntime(payload.tabId, { snapshot: null });
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Last-URL persistence — debounced runtime store → tabs store dispatch
// ---------------------------------------------------------------------------

/** Unsubscribe handle returned by zustand subscribe. */
let lastUrlPersistUnsub: (() => void) | null = null;

/**
 * Resolve the workspaceId that owns `tabId` by scanning the tabs store.
 * Returns `undefined` when no workspace has an entry for `tabId`.
 *
 * Linear scan is acceptable here: the number of workspaces × tabs is small
 * (tens at most) and this path is debounced to at most 4 calls/sec.
 */
function findWorkspaceForTab(tabId: string): string | undefined {
  const byWorkspace = useTabsStore.getState().byWorkspace;
  for (const [workspaceId, tabRecord] of Object.entries(byWorkspace)) {
    if (tabId in tabRecord) return workspaceId;
  }
  return undefined;
}

/**
 * Install (or reinstall) the runtime store → tabs store last-URL persistence
 * subscription.
 *
 * Accepts an optional `scheduler` so tests can inject a fake timer without
 * touching the global clock.
 *
 * Safe to call multiple times — the previous subscription is torn down first.
 */
export function initBrowserLastUrlPersistence(scheduler?: TimerScheduler): void {
  // Tear down any prior subscription.
  if (lastUrlPersistUnsub) {
    lastUrlPersistUnsub();
    lastUrlPersistUnsub = null;
  }

  const debouncer = createKeyedDebouncer<string>({
    delayMs: BROWSER_LAST_URL_SAVE_DEBOUNCE_MS,
    ...(scheduler ? { scheduler } : {}),
  });

  // Track the previous snapshot of runtimes so we can detect per-tab URL
  // changes without reacting to unrelated fields (isLoading, title, etc.).
  let prevRuntimes = useBrowserRuntimeStore.getState().runtimes;

  lastUrlPersistUnsub = useBrowserRuntimeStore.subscribe((state) => {
    const nextRuntimes = state.runtimes;
    if (nextRuntimes === prevRuntimes) return;

    for (const [tabId, runtime] of nextRuntimes) {
      const prev = prevRuntimes.get(tabId);
      if (prev?.currentUrl === runtime.currentUrl) continue;
      // currentUrl changed for this tab — schedule a debounced persist.
      const url = runtime.currentUrl;
      debouncer.schedule(tabId, () => {
        const workspaceId = findWorkspaceForTab(tabId);
        if (!workspaceId) return;
        useTabsStore.getState().setBrowserLastUrl(workspaceId, tabId, url);
      });
    }

    prevRuntimes = nextRuntimes;
  });
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
