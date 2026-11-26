import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PANE_FRAME_FOCUS_EVENT } from "@/utils/pane-activation";
import { PREVIEW_LINK_WINDOW } from "../../../../shared/window/preview-link";
import { ipcCallResult } from "../../../ipc/client";
import {
  createDomFinder,
  FIND_COLORS,
  MAX_FIND_MATCHES,
} from "../../../services/editor/preview/find/dom-finder";
import { findMatches } from "../../../services/editor/preview/find/find-matches";
import {
  buildPreviewDocument,
  type PreviewScopeCandidate,
  previewSafeHtml,
  previewScopeCandidates,
  scopedBase,
} from "../../../services/editor/preview/html-document";
import {
  PreviewDocumentLoader,
  type PreviewDocumentStore,
  type PreviewFrame,
} from "../../../services/editor/preview/preview-document-loader";
import { peerOf, peerRoot } from "../../../services/remote/peer-workspace";
import { useWorkspace } from "../../../state/stores/workspaces";
import { type FindResult, usePreviewFindBar, usePreviewFinder } from "./preview-find";

interface HtmlPreviewProps {
  source: string;
  workspaceId: string;
  currentFileAbsPath: string;
  thumb?: { title: string; className: string; style: React.CSSProperties };
}

const HTML_PREVIEW_PREAMBLE = `<style>
  ::-webkit-scrollbar { width: 10px; height: 8px; }
  ::-webkit-scrollbar-track { background: rgba(127, 127, 127, 0.06); }
  ::-webkit-scrollbar-thumb {
    background: rgba(127, 127, 127, 0.5);
    border-radius: 4px;
    border: 2px solid transparent;
    background-clip: padding-box;
  }
  ::-webkit-scrollbar-thumb:hover {
    background: rgba(127, 127, 127, 0.75);
    background-clip: padding-box;
  }
  ::-webkit-scrollbar-corner { background: transparent; }
</style>
<script>
(function () {
  ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel'].forEach(function (name) {
    try {
      Object.defineProperty(window, name, { value: undefined, writable: false, configurable: false });
    } catch (_) {}
  });
})();
</script>
<script>
(function () {
  // Moving between previews can leave the parent window blurred throughout.
  window.addEventListener('focus', function () {
    parent.postMessage({ nexusHtmlPreview: 'focus' }, '*');
  });

  // The page's own window.open asks the host too, as its links do: the
  // sandbox lets it open nothing itself.
  try {
    window.open = function (url) {
      try {
        var href = new URL(String(url), document.baseURI).href;
        parent.postMessage({ nexusHtmlPreview: 'open', href: href }, '*');
      } catch (_) {}
      return null;
    };
  } catch (_) {}

  function linkHref(a) {
    var href = a.getAttribute('href');
    if (href === null) href = a.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
    return href;
  }
  function inPage(name) {
    var names = [name];
    try {
      var decoded = decodeURIComponent(name);
      if (decoded !== name) names.unshift(decoded);
    } catch (_) {}
    for (var i = 0; i < names.length; i++) {
      var found = null;
      try { found = document.getElementById(names[i]); } catch (_) {}
      if (!found) {
        var named = document.getElementsByName(names[i]);
        for (var j = 0; j < named.length && !found; j++) {
          if (named[j].localName === 'a') found = named[j];
        }
      }
      if (found) return found;
    }
    return null;
  }
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || typeof t.closest !== 'function') return;
    var a = t.closest('a, area');
    if (!a) return;
    var href = linkHref(a);
    if (!href) return;
    if (href.charAt(0) === '#') {
      e.preventDefault();
      var id = href.slice(1);
      if (!id) return;
      var target = inPage(id);
      if (target && typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ behavior: 'auto', block: 'start' });
      }
      return;
    }
    e.preventDefault();
    try {
      var resolved = new URL(href, document.baseURI).href;
      parent.postMessage({ nexusHtmlPreview: 'open', href: resolved }, '*');
    } catch (_) {}
  }, true);

  // Scroll persistence. While a restore is pending we keep re-applying it as
  // the document grows, and stay quiet so the host's remembered position is
  // not overwritten by the intermediate (clamped) offsets.
  var restore = null;
  var restoreTimer = 0;
  var restoreObserver = null;
  var meta = document.querySelector('meta[name="nexus-preview-scroll"]');
  if (meta) {
    var parts = (meta.getAttribute('content') || '').split(',');
    var rx = Number(parts[0]) || 0;
    var ry = Number(parts[1]) || 0;
    if (rx > 0 || ry > 0) restore = { x: rx, y: ry };
    if (meta.parentNode) meta.parentNode.removeChild(meta);
  }
  function stopRestore() {
    if (!restore) return;
    restore = null;
    clearTimeout(restoreTimer);
    if (restoreObserver) restoreObserver.disconnect();
  }
  function applyRestore() {
    if (!restore) return;
    // 'instant' bypasses a page-level scroll-behavior: smooth.
    window.scrollTo({ left: restore.x, top: restore.y, behavior: 'instant' });
    if (Math.abs(window.scrollX - restore.x) < 1 && Math.abs(window.scrollY - restore.y) < 1) {
      stopRestore();
    }
  }
  if (restore) {
    restoreTimer = setTimeout(stopRestore, 2000);
    document.addEventListener('DOMContentLoaded', applyRestore);
    window.addEventListener('load', applyRestore);
    if (typeof ResizeObserver === 'function') {
      restoreObserver = new ResizeObserver(applyRestore);
      restoreObserver.observe(document.documentElement);
    }
    ['wheel', 'touchstart', 'keydown', 'mousedown'].forEach(function (type) {
      window.addEventListener(type, stopRestore, { capture: true, passive: true });
    });
  }
  var reportQueued = false;
  window.addEventListener('scroll', function () {
    if (restore || reportQueued) return;
    reportQueued = true;
    requestAnimationFrame(function () {
      reportQueued = false;
      try {
        parent.postMessage({ nexusHtmlPreview: 'scroll', x: window.scrollX, y: window.scrollY }, '*');
      } catch (_) {}
    });
  }, { passive: true });
})();
</script>
<script>
(function () {
  var createDomFinder = ${createDomFinder.toString()};
  var findMatches = ${findMatches.toString()};
  var finder = null;
  function post(message) {
    try { parent.postMessage(message, '*'); } catch (_) {}
  }
  function get() {
    if (!finder) {
      finder = createDomFinder(
        function () { return document.body || document.documentElement; },
        findMatches,
        ${MAX_FIND_MATCHES},
        'nexus-find',
        ${JSON.stringify(FIND_COLORS)},
        function (total, current) {
          post({ nexusHtmlPreview: 'find', total: total, current: current });
        }
      );
    }
    return finder;
  }
  window.addEventListener('message', function (e) {
    if (e.source !== parent) return;
    var d = e.data;
    if (!d || typeof d !== 'object') return;
    var op = d.nexusHtmlPreviewFind;
    if (op === 'search') get().search(String(d.query || ''), d.caseSensitive === true);
    else if (op === 'move') get().move(d.direction === -1 ? -1 : 1);
    else if (op === 'clear' && finder) finder.clear();
  });
  document.addEventListener('keydown', function (e) {
    var key = (e.key || '').toLowerCase();
    var mod = (e.metaKey || e.ctrlKey) && !e.altKey;
    if (mod && !e.shiftKey && key === 'f') {
      e.preventDefault();
      post({ nexusHtmlPreview: 'find-open' });
    } else if (mod && key === 'g') {
      e.preventDefault();
      post({ nexusHtmlPreview: 'find-move', direction: e.shiftKey ? -1 : 1 });
    } else if (e.key === 'Escape') {
      post({ nexusHtmlPreview: 'find-close' });
    }
  }, true);
})();
</script>`;

const RELOAD_DEBOUNCE_MS = 300;

const MAX_LINK_CHARS = 8192;

interface ScrollPosition {
  x: number;
  y: number;
}

const scrollByFile = new Map<string, ScrollPosition>();

function buildScrollMeta(scroll: ScrollPosition | undefined): string {
  if (!scroll) return "";
  const x = Math.max(0, Math.round(scroll.x) || 0);
  const y = Math.max(0, Math.round(scroll.y) || 0);
  if (x === 0 && y === 0) return "";
  return `<meta name="nexus-preview-scroll" content="${x},${y}">`;
}

interface PreviewScope {
  scope: string;
  base: string;
}

function buildBaseTag(scope: PreviewScope | null): string {
  return scope ? `<base href="${scope.base}">` : "";
}

function usePreviewScope(
  workspaceId: string,
  candidates: readonly PreviewScopeCandidate[],
): PreviewScope | null | undefined {
  const [held, setHeld] = useState<{ key: string; scope: PreviewScope | null } | null>(null);
  const key = `${workspaceId}\0${candidates.map(({ dir, sub }) => `${dir}\0${sub}`).join("\0")}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the candidates
  useEffect(() => {
    let live = true;
    const open = async (): Promise<PreviewScope | null> => {
      for (const { dir, sub } of candidates) {
        const result = await ipcCallResult("preview", "openScope", { workspaceId, dir }).catch(
          () => null,
        );
        const scope = result?.ok ? result.value : null;
        if (scope) return { scope: scope.scope, base: scopedBase(scope.base, sub) };
      }
      return null;
    };
    void open().then((scope) => {
      if (live) setHeld({ key, scope });
    });
    return () => {
      live = false;
    };
  }, [workspaceId, key]);
  return held?.key === key ? held.scope : undefined;
}

function injectPreamble(source: string, baseTag: string, scrollMeta: string): string {
  return buildPreviewDocument(
    previewSafeHtml(source),
    baseTag + scrollMeta + HTML_PREVIEW_PREAMBLE,
  );
}

const previewDocumentStore: PreviewDocumentStore = {
  async put(html, token, scope) {
    const result = await ipcCallResult("preview", "putHtml", {
      token,
      html,
      ...(scope ? { scope } : {}),
    });
    return result.ok ? result.value : null;
  },
  release(token) {
    void ipcCallResult("preview", "releaseHtml", { token });
  },
};

function iframeFrame(el: HTMLIFrameElement): PreviewFrame {
  return {
    setSrc: (url) => {
      el.src = url;
    },
    replace: (url) => el.contentWindow?.location.replace(url),
  };
}

export function HtmlPreview({ source, workspaceId, currentFileAbsPath, thumb }: HtmlPreviewProps) {
  const { t } = useTranslation();
  const root = useWorkspace(workspaceId, (w) =>
    w ? (w.location.kind === "local" ? w.location.rootPath : w.location.remotePath) : "",
  );
  const workspaceRoot = peerOf(workspaceId) ? peerRoot(workspaceId) : root;
  const candidates = useMemo(
    () => previewScopeCandidates(currentFileAbsPath, workspaceRoot),
    [currentFileAbsPath, workspaceRoot],
  );
  const scope = usePreviewScope(workspaceId, candidates);
  const baseTag = buildBaseTag(scope ?? null);
  const scrollKey = `${workspaceId}\0${currentFileAbsPath}`;
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const findBar = usePreviewFindBar();
  const findRef = useRef<{ query: string; caseSensitive: boolean } | null>(null);
  const reportRef = useRef<(result: FindResult) => void>(() => {});

  const postFind = useCallback((message: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage(message, "*");
  }, []);
  usePreviewFinder(
    useCallback(
      (report: (result: FindResult) => void) => {
        reportRef.current = report;
        return {
          search(query: string, caseSensitive: boolean) {
            findRef.current = { query, caseSensitive };
            postFind({ nexusHtmlPreviewFind: "search", query, caseSensitive });
          },
          move(direction: 1 | -1) {
            postFind({ nexusHtmlPreviewFind: "move", direction });
          },
          clear() {
            findRef.current = null;
            postFind({ nexusHtmlPreviewFind: "clear" });
          },
        };
      },
      [postFind],
    ),
  );

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const el = iframeRef.current;
      if (!el || e.source !== el.contentWindow) return;
      const data: unknown = e.data;
      if (typeof data !== "object" || data === null) return;
      const msg = data as {
        nexusHtmlPreview?: unknown;
        x?: unknown;
        y?: unknown;
        total?: unknown;
        current?: unknown;
        direction?: unknown;
        href?: unknown;
      };
      switch (msg.nexusHtmlPreview) {
        case "focus":
          el.dispatchEvent(new Event(PANE_FRAME_FOCUS_EVENT, { bubbles: true }));
          return;
        case "find": {
          const total = Number(msg.total);
          const current = Number(msg.current);
          if (Number.isInteger(total) && Number.isInteger(current) && total >= 0) {
            reportRef.current({ total, current: Math.min(Math.max(current, 0), total) });
          }
          return;
        }
        case "find-open":
          findBar.open();
          return;
        case "find-close":
          findBar.close();
          return;
        case "find-move":
          if (findRef.current)
            postFind({ nexusHtmlPreviewFind: "move", direction: msg.direction === -1 ? -1 : 1 });
          return;
        case "open":
          if (typeof msg.href === "string" && msg.href.length <= MAX_LINK_CHARS) {
            window.open(msg.href, PREVIEW_LINK_WINDOW, "noopener,noreferrer");
          }
          return;
      }
      if (msg.nexusHtmlPreview !== "scroll") return;
      const x = Number(msg.x);
      const y = Number(msg.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      scrollByFile.set(scrollKey, { x, y });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [scrollKey, findBar, postFind]);

  const loaderRef = useRef<PreviewDocumentLoader | null>(null);
  useEffect(() => {
    const loader = new PreviewDocumentLoader(previewDocumentStore, () => {
      const el = iframeRef.current;
      return el ? iframeFrame(el) : null;
    });
    loaderRef.current = loader;
    return () => {
      loader.close();
      loaderRef.current = null;
    };
  }, []);

  const assignedRef = useRef<{ source: string; baseTag: string } | null>(null);
  const scopeId = scope?.scope;
  useEffect(() => {
    const el = iframeRef.current;
    if (!el || scope === undefined) return;
    const assigned = assignedRef.current;
    if (assigned && assigned.source === source && assigned.baseTag === baseTag) return;
    const assign = () => {
      assignedRef.current = { source, baseTag };
      void loaderRef.current?.load(
        injectPreamble(source, baseTag, buildScrollMeta(scrollByFile.get(scrollKey))),
        scopeId,
      );
    };
    if (assigned === null) {
      assign();
      return;
    }
    const timer = setTimeout(assign, RELOAD_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [source, baseTag, scrollKey, scope, scopeId]);

  if (thumb) {
    return (
      <iframe
        ref={iframeRef}
        sandbox="allow-scripts"
        allow=""
        referrerPolicy="no-referrer"
        title={thumb.title}
        aria-hidden
        tabIndex={-1}
        className={thumb.className}
        style={thumb.style}
        data-testid="chat-artifact-thumb"
      />
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <iframe
        ref={iframeRef}
        sandbox="allow-scripts"
        allow=""
        referrerPolicy="no-referrer"
        title={t("preview.html_title")}
        onLoad={() => {
          const find = findRef.current;
          if (find) postFind({ nexusHtmlPreviewFind: "search", ...find });
        }}
        className="w-full flex-1 border-0 bg-[var(--surface-island-bg)]"
      />
    </div>
  );
}
