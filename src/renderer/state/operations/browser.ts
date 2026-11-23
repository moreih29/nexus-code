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

const browserViews = new Map<string, { workspaceId: string; viewId: string }>();

export function beginBrowserView(workspaceId: string, tabId: string): string {
  const viewId = crypto.randomUUID();
  browserViews.set(tabId, { workspaceId, viewId });
  return viewId;
}

export function endBrowserView(tabId: string, viewId: string): void {
  if (browserViews.get(tabId)?.viewId !== viewId) return;
  browserViews.delete(tabId);
  useBrowserRuntimeStore.getState().removeRuntime(tabId);
}

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

export function initBrowserRuntimeSubscriptions(): void {
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

  activeUnsubs.push(
    listenToView("refused", ({ url, kind, message }, workspaceId) => {
      showForwardFailure(workspaceId, loopbackPort(url) ?? 0, kind, message);
    }),
  );

  activeUnsubs.push(
    listenToView("titleUpdated", ({ tabId, title }, workspaceId) => {
      useBrowserRuntimeStore.getState().setRuntime(tabId, { title });
      useTabsStore.getState().setProcessTitle(workspaceId, tabId, title);
    }),
  );

  activeUnsubs.push(
    listenToView("faviconUpdated", ({ tabId, favicons }) => {
      const next = favicons && favicons.length > 0 ? favicons[0] : null;
      useBrowserRuntimeStore.getState().setRuntime(tabId, { faviconUrl: next });
    }),
  );

  activeUnsubs.push(
    listenToView("snapshot", (payload) => {
      if (payload.kind === "set") {
        useBrowserRuntimeStore.getState().setRuntime(payload.tabId, { snapshot: payload.dataUrl });
      } else {
        useBrowserRuntimeStore.getState().setRuntime(payload.tabId, { snapshot: null });
      }
    }),
  );

  activeUnsubs.push(
    listenToView("devtoolsToggled", ({ tabId, open }) => {
      useBrowserRuntimeStore.getState().setRuntime(tabId, { devtoolsOpen: open });
    }),
  );

  activeUnsubs.push(
    listenToView("focused", ({ tabId }) => {
      activateGroupForTab(tabId);
    }),
  );

  activeUnsubs.push(
    listenToView("focusUrl", ({ tabId }) => {
      useBrowserRuntimeStore.getState().requestUrlFocus(tabId);
    }),
  );

  activeUnsubs.push(
    ipcListen("browser", "downloaded", ({ file }) => {
      showToast({ kind: "info", message: i18next.t("common:browser.downloaded", { file }) });
    }),
  );
}

export function activateGroupForTab(tabId: string): void {
  const workspaceId = findWorkspaceForTab(tabId);
  if (!workspaceId) return;
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) return;
  const owner = Grid.allLeaves(layout.root).find((leaf) => leaf.tabIds.includes(tabId));
  if (!owner || layout.activeGroupId === owner.id) return;
  useLayoutStore.getState().setActiveGroup(workspaceId, owner.id);
}

function findWorkspaceForTab(tabId: string): string | undefined {
  const byWorkspace = useTabsStore.getState().byWorkspace;
  for (const [workspaceId, tabRecord] of Object.entries(byWorkspace)) {
    if (tabId in tabRecord) return workspaceId;
  }
  return undefined;
}

export function resolveInitialBrowserUrl(props: BrowserTabProps): string | null {
  if (props.lastUrl && isNavigationSchemeAllowed(props.lastUrl)) {
    return props.lastUrl;
  }
  return null;
}
