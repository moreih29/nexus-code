// HtmlPreview — renders user-supplied HTML inside a sandboxed iframe.
//
// DOCUMENT ADDRESS
//   The page, with the preamble below, is put in main and the iframe loads
//   it from nexus-preview://<token>/ (main's custom-protocols/
//   nexus-preview.ts). A srcdoc document would take on the app window's
//   Content-Security-Policy, which keeps the app's own frame from running
//   inline or remote script; a document of a scheme of its own runs under the
//   looser policy its response carries, as the page would in a browser. The
//   pane keeps one token while it is open and lets main go of it when it
//   closes.
//
// SECURITY MODEL (plan 60 issue 3, revised v1.2)
//   Workspace HTML often includes inline scripts and CDN-loaded libraries
//   (mermaid, chart.js, d3) that the user expects to "just work" — the same
//   way they would when the file is opened directly in Chrome. Sandbox grants:
//     - `allow-scripts`  → script execution + CDN fetches.
//     - `allow-forms`    → form submission. Without it the browser drops a
//                          submit before the `submit` event fires, so pages
//                          that handle forms in script stop working. A
//                          submit only navigates the iframe itself, which
//                          scripts can already do.
//     - `allow-modals`   → alert/confirm/prompt, which pages call the way
//                          they would in Chrome.
//
//   Absent tokens we deliberately keep off:
//     - `allow-same-origin` → iframe at opaque origin; no cross-talk with
//                             our renderer's globals or storage.
//     - `allow-top-navigation` → cannot navigate the outer window.
//     - `allow-popups` → the page cannot call window.open itself. Its
//        links go through the host (2. below), so main can tell them from
//        the app's own and let them open only while the keyboard is in the
//        preview: keys typed in the editor do not let a page's timer open
//        links.
//     - `allow-downloads` / `allow-popups-to-escape-sandbox` → keep
//        workspace HTML on the same restricted floor as scripts inside it.
//
//   `allow=""` and `referrerpolicy="no-referrer"` keep Feature-Policy
//   delegations and Referer leakage on inline-loaded resources locked down.
//
//   The `nexus-workspace://` protocol guard in main remains the boundary
//   that prevents iframe-injected fetches from reading workspace files
//   the user did not target.
//
// INJECTED PREAMBLE
//   We prepend a tiny CSS + JS preamble into the document so the previewed
//   document inherits three host behaviours:
//
//   1. `::-webkit-scrollbar` — themed to match the app's thin scrollbar.
//      Colors are neutral semi-transparent grays (the iframe is opaque-
//      origin, so it cannot read our theme tokens; the chosen alpha works
//      on both light and dark page backgrounds).
//
//   2. Link interception — `document.addEventListener('click', …)` in the
//      capture phase turns every <a href> click (other than in-page
//      `#anchor`) into a message asking the host to open the link, its
//      address resolved against the document's base. The host opens it
//      with window.open under PREVIEW_LINK_WINDOW; main's
//      setWindowOpenHandler routes the URL through the allowlist:
//      http/https/mailto open in the OS default browser, everything else
//      is denied silently. The page's own window.open asks the host the
//      same way. Without this interception, clicking a link
//      would navigate the iframe itself — most external sites refuse
//      iframe embedding (X-Frame-Options / frame-ancestors), so the user
//      would see a blank pane and lose the preview.
//
//   3. Find — the document finds in its own text (dom-finder.ts, from its
//      source) when the host's find bar asks, and reports the count back;
//      ⌘F, ⌘G and Escape in it reach the host's find bar.
//
//   4. Scroll persistence — every reload is a brand-new document
//      that starts at (0, 0). The preamble reports window scroll back to the
//      host (postMessage), the host remembers it per file, and the next
//      document is seeded with that position via a
//      `<meta name="nexus-preview-scroll">` the preamble reads and chases
//      while late content (images, mermaid, charts) grows the page.
//
// RELOAD CADENCE
//   The first document of a mount is assigned immediately; later source
//   changes (typing, or an external writer such as an agent / formatter /
//   git rewriting the file) are trailing-debounced. One reload per burst
//   instead of one per animation frame keeps the full-document rebuild +
//   IPC + re-parse off the shared renderer thread (where the terminal also
//   lives) and collapses truncate-then-write saves into a single reload.

import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { isWithinWorkspace, relPath } from "@/utils/path";
import { PREVIEW_LINK_WINDOW } from "../../../../shared/window/preview-link";
import { ipcCallResult } from "../../../ipc/client";
import {
  createDomFinder,
  FIND_COLORS,
  MAX_FIND_MATCHES,
} from "../../../services/editor/preview/find/dom-finder";
import { findMatches } from "../../../services/editor/preview/find/find-matches";
import { buildPreviewDocument } from "../../../services/editor/preview/html-document";
import {
  PreviewDocumentLoader,
  type PreviewDocumentStore,
  type PreviewFrame,
} from "../../../services/editor/preview/preview-document-loader";
import {
  buildOutsideDirUrl,
  buildWorkspaceDirUrl,
} from "../../../services/editor/preview/workspace-url";
import { peerOf } from "../../../services/remote/peer-workspace";
import { useOutsideDirGranted } from "../../../state/stores/outside-grants";
import { type FindResult, usePreviewFindBar, usePreviewFinder } from "./preview-find";

interface HtmlPreviewProps {
  source: string;
  /** Workspace owning the previewed file — used to resolve sibling resources. */
  workspaceId: string;
  /** Absolute (POSIX) path of the HTML file being previewed. */
  currentFileAbsPath: string;
  /** Absolute (POSIX) path of the workspace root. */
  workspaceRootAbsPath: string;
}

/**
 * CSS + JS we inject at the head of every previewed document.
 *
 * Kept as a single string constant (no template substitution from caller
 * input) so there is no risk of source content leaking into the script
 * body. The script is wrapped in an IIFE to avoid leaking globals into
 * the workspace HTML's own scope.
 */
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

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || typeof t.closest !== 'function') return;
    var a = t.closest('a');
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href) return;
    // In-page anchor — scroll inside the iframe document directly. We do
    // NOT fall through to native hash navigation: the <base> we inject
    // resolves "#id" against the file's folder on nexus-workspace://, so
    // the frame would leave the document for that address. Calling
    // scrollIntoView keeps the document stable.
    if (href.charAt(0) === '#') {
      e.preventDefault();
      var id = href.slice(1);
      if (!id) return;
      var target = null;
      try { target = document.getElementById(id); } catch (_) {}
      if (!target) {
        try { target = document.querySelector('a[name="' + id + '"]'); } catch (_) {}
      }
      if (target && typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ behavior: 'auto', block: 'start' });
      }
      return;
    }
    // Everything else: the host opens it (the sandbox has no allow-popups),
    // resolved against the document's base. main's setWindowOpenHandler
    // applies the http/https/mailto allowlist.
    e.preventDefault();
    try { parent.postMessage({ nexusHtmlPreview: 'open', href: a.href }, '*'); } catch (_) {}
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

/** Trailing debounce for live-edit reloads (see RELOAD CADENCE). */
const RELOAD_DEBOUNCE_MS = 300;

/** The longest link address a previewed page may ask the host to open. */
const MAX_LINK_CHARS = 8192;

interface ScrollPosition {
  x: number;
  y: number;
}

/**
 * Last scroll position reported by each previewed file's document, keyed by
 * workspace + absolute path. Module-level so it survives HtmlPreview remounts
 * (raw↔preview toggle, a transient read error unmounting the pane) — the next
 * mount's first document restores it.
 */
const scrollByFile = new Map<string, ScrollPosition>();

/**
 * `<meta>` carrying the restore target for the preamble. Values are coerced to
 * non-negative integers here, so nothing but digits reaches the markup.
 */
function buildScrollMeta(scroll: ScrollPosition | undefined): string {
  if (!scroll) return "";
  const x = Math.max(0, Math.round(scroll.x) || 0);
  const y = Math.max(0, Math.round(scroll.y) || 0);
  if (x === 0 && y === 0) return "";
  return `<meta name="nexus-preview-scroll" content="${x},${y}">`;
}

/**
 * Build the `<base href>` tag that lets the iframe resolve relatively-
 * referenced sibling resources (`<script src="x.js">`, `<link href="x.css">`,
 * images, fonts) against the file's on-disk directory via the
 * `nexus-workspace://` protocol — the same disk/agent-served path image and
 * markdown previews already use, so it works for local AND SSH workspaces.
 *
 * Returns "" when the file is not inside the workspace root: we cannot mint a
 * workspace URL for it, so relative resources stay unresolved (same as before
 * this feature) rather than pointing somewhere wrong. The exception is a file
 * whose folder a Claude tab granted (`outsideDirGranted`): its siblings are
 * served from there.
 *
 * MUST be emitted before any resource reference in the document — see
 * injectPreamble, which places it at the very top of <head>.
 */
function buildBaseTag(
  workspaceId: string,
  currentFileAbsPath: string,
  workspaceRootAbsPath: string,
  outsideDirGranted = false,
): string {
  const slash = currentFileAbsPath.lastIndexOf("/");
  const dirAbs = slash === -1 ? currentFileAbsPath : currentFileAbsPath.slice(0, slash);
  if (!isWithinWorkspace(currentFileAbsPath, workspaceRootAbsPath)) {
    return outsideDirGranted ? `<base href="${buildOutsideDirUrl(workspaceId, dirAbs)}">` : "";
  }
  const baseHref = peerOf(workspaceId)
    ? buildOutsideDirUrl(workspaceId, dirAbs)
    : buildWorkspaceDirUrl(workspaceId, relPath(dirAbs, workspaceRootAbsPath));
  return `<base href="${baseHref}">`;
}

/**
 * The document served for the source HTML: the base tag + preamble first in
 * its head, after its DOCTYPE (buildPreviewDocument), so nothing precedes the
 * DOCTYPE and the page keeps its mode.
 *
 * The `<base>` must come FIRST so the user's own <link>/<script src> tags
 * (which follow inside their <head>) resolve against it. The scroll meta must
 * precede the preamble script, which reads it synchronously.
 */
function injectPreamble(source: string, baseTag: string, scrollMeta: string): string {
  return buildPreviewDocument(source, baseTag + scrollMeta + HTML_PREVIEW_PREAMBLE);
}

/** Main's store of preview documents, over the preview channel. */
const previewDocumentStore: PreviewDocumentStore = {
  async put(html, token) {
    const result = await ipcCallResult("preview", "putHtml", { token, html });
    return result.ok ? result.value : null;
  },
  release(token) {
    void ipcCallResult("preview", "releaseHtml", { token });
  },
};

/** The pane's iframe, as the loader points it at a document. */
function iframeFrame(el: HTMLIFrameElement): PreviewFrame {
  return {
    setSrc: (url) => {
      el.src = url;
    },
    replace: (url) => el.contentWindow?.location.replace(url),
  };
}

export function HtmlPreview({
  source,
  workspaceId,
  currentFileAbsPath,
  workspaceRootAbsPath,
}: HtmlPreviewProps) {
  const { t } = useTranslation();
  // No size cap here: the iframe parses off the renderer's main thread, so
  // large HTML documents render without blocking the UI (unlike markdown/svg).
  // A sibling of an HTML file outside the workspace is granted with its folder.
  const outsideDirGranted = useOutsideDirGranted(
    workspaceId,
    currentFileAbsPath.slice(0, currentFileAbsPath.lastIndexOf("/")),
  );
  const baseTag = buildBaseTag(
    workspaceId,
    currentFileAbsPath,
    workspaceRootAbsPath,
    // Another computer serves any file of the workspace's folders, which it keeps them to.
    outsideDirGranted || peerOf(workspaceId) !== null,
  );
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

  // Scroll reports from the preamble. Only messages whose source is OUR
  // iframe's window are accepted; the payload is reduced to two numbers.
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
          // Named, so main knows the link is the page's (PREVIEW_LINK_WINDOW).
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

  // The pane's document in main (DOCUMENT ADDRESS), let go of when the
  // pane closes: its tab, the raw↔preview toggle, its window.
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

  // The iframe element stays mounted across live edits (no remount cascade);
  // its document is reloaded instead. PreviewPane already unmounts/remounts
  // HtmlPreview around the raw↔preview toggle, so the "empty → first
  // content" path also goes through this effect on fresh mount.
  //
  // The document string is built only when it is actually assigned, and the
  // "did anything change" check compares the inputs (usually the identical
  // string instance from the model) instead of the potentially multi-megabyte
  // document.
  const assignedRef = useRef<{ source: string; baseTag: string } | null>(null);
  useEffect(() => {
    const el = iframeRef.current;
    if (!el) return;
    const assigned = assignedRef.current;
    if (assigned && assigned.source === source && assigned.baseTag === baseTag) return;
    const assign = () => {
      assignedRef.current = { source, baseTag };
      void loaderRef.current?.load(
        injectPreamble(source, baseTag, buildScrollMeta(scrollByFile.get(scrollKey))),
      );
    };
    if (assigned === null) {
      assign();
      return;
    }
    const timer = setTimeout(assign, RELOAD_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [source, baseTag, scrollKey]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <iframe
        ref={iframeRef}
        sandbox="allow-scripts allow-forms allow-modals"
        allow=""
        referrerPolicy="no-referrer"
        title={t("preview.html_title")}
        // A new document of a changed file is found in again.
        onLoad={() => {
          const find = findRef.current;
          if (find) postFind({ nexusHtmlPreviewFind: "search", ...find });
        }}
        className="w-full flex-1 border-0 bg-[var(--surface-island-bg)]"
      />
    </div>
  );
}
