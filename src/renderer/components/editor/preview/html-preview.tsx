// HtmlPreview — renders user-supplied HTML inside a sandboxed iframe.
//
// SECURITY MODEL (plan 60 issue 3, revised v1.2)
//   Workspace HTML often includes inline scripts and CDN-loaded libraries
//   (mermaid, chart.js, d3) that the user expects to "just work" — the same
//   way they would when the file is opened directly in Chrome. Sandbox grants:
//     - `allow-scripts`  → script execution + CDN fetches.
//     - `allow-popups`   → `window.open` (and our injected link-handler) can
//                          reach main's setWindowOpenHandler. That handler
//                          is the actual gate — only http/https/mailto are
//                          allowed through to shell.openExternal.
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
//   We prepend a tiny CSS + JS preamble into the srcDoc so the previewed
//   document inherits three host behaviours:
//
//   1. `::-webkit-scrollbar` — themed to match the app's thin scrollbar.
//      Colors are neutral semi-transparent grays (the iframe is opaque-
//      origin, so it cannot read our theme tokens; the chosen alpha works
//      on both light and dark page backgrounds).
//
//   2. Link interception — `document.addEventListener('click', …)` in the
//      capture phase rewrites every <a href> click (other than in-page
//      `#anchor`) into a `window.open(href, '_blank')` call. main's
//      setWindowOpenHandler then routes the URL through the allowlist:
//      http/https/mailto open in the OS default browser, everything else
//      is denied silently. Without this interception, clicking a link
//      would navigate the iframe itself — most external sites refuse
//      iframe embedding (X-Frame-Options / frame-ancestors), so the user
//      would see a blank pane and lose the preview.
//
//   3. Scroll persistence — every srcdoc assignment is a brand-new document
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

import { useEffect, useRef } from "react";
import { isWithinWorkspace, relPath } from "@/utils/path";
import { buildWorkspaceDirUrl } from "../../../services/editor/preview/workspace-url";
import { useTranslation } from "react-i18next";

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
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || typeof t.closest !== 'function') return;
    var a = t.closest('a');
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href) return;
    // In-page anchor — scroll inside the iframe document directly. We do
    // NOT fall through to native hash navigation: in some Chromium builds
    // a hash change on about:srcdoc forces the parser to re-evaluate the
    // srcDoc, which (because allow-same-origin is off) ends up as a blank
    // document. Calling scrollIntoView keeps the document stable.
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
    // Everything else: defer to the host. window.open is intercepted by
    // main's setWindowOpenHandler, which applies the http/https/mailto
    // allowlist and calls shell.openExternal for allowed URLs.
    e.preventDefault();
    try { window.open(href, '_blank'); } catch (_) {}
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
</script>`;

/** Trailing debounce for live-edit reloads (see RELOAD CADENCE). */
const RELOAD_DEBOUNCE_MS = 300;

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
 * this feature) rather than pointing somewhere wrong.
 *
 * MUST be emitted before any resource reference in the document — see
 * injectPreamble, which places it at the very top of <head>.
 */
function buildBaseTag(
  workspaceId: string,
  currentFileAbsPath: string,
  workspaceRootAbsPath: string,
): string {
  if (!isWithinWorkspace(currentFileAbsPath, workspaceRootAbsPath)) return "";
  const slash = currentFileAbsPath.lastIndexOf("/");
  const dirAbs = slash === -1 ? currentFileAbsPath : currentFileAbsPath.slice(0, slash);
  const baseHref = buildWorkspaceDirUrl(workspaceId, relPath(dirAbs, workspaceRootAbsPath));
  return `<base href="${baseHref}">`;
}

/**
 * Insert the base tag + preamble into the source HTML.  We try to keep DOCTYPE
 * order intact (browsers go quirks-mode if anything precedes <!DOCTYPE>) by
 * inserting right after the opening <head> tag.  When no <head> exists we
 * fall back to a prepend; modern Chromium is lenient enough to re-parse
 * style/script tags into the synthesised <head>.
 *
 * The `<base>` must come FIRST so the user's own <link>/<script src> tags
 * (which follow inside their <head>) resolve against it. The scroll meta must
 * precede the preamble script, which reads it synchronously.
 */
function injectPreamble(source: string, baseTag: string, scrollMeta: string): string {
  const head = baseTag + scrollMeta + HTML_PREVIEW_PREAMBLE;
  const headOpen = /<head\b[^>]*>/i.exec(source);
  if (headOpen) {
    const insertAt = headOpen.index + headOpen[0].length;
    return source.slice(0, insertAt) + head + source.slice(insertAt);
  }
  return head + source;
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
  const baseTag = buildBaseTag(workspaceId, currentFileAbsPath, workspaceRootAbsPath);
  const scrollKey = `${workspaceId}\0${currentFileAbsPath}`;
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Scroll reports from the preamble. Only messages whose source is OUR
  // iframe's window are accepted; the payload is reduced to two numbers.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const el = iframeRef.current;
      if (!el || e.source !== el.contentWindow) return;
      const data: unknown = e.data;
      if (typeof data !== "object" || data === null) return;
      const msg = data as { nexusHtmlPreview?: unknown; x?: unknown; y?: unknown };
      if (msg.nexusHtmlPreview !== "scroll") return;
      const x = Number(msg.x);
      const y = Number(msg.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      scrollByFile.set(scrollKey, { x, y });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [scrollKey]);

  // Imperatively set `srcdoc` so the iframe element stays mounted across
  // live edits (no remount cascade). The known Chromium srcDoc-prop-not-
  // reloading bug is side-stepped because we touch the DOM attribute
  // directly — the browser reliably re-parses on assignment. PreviewPane
  // already unmounts/remounts HtmlPreview around the raw↔preview toggle,
  // so the "empty → first content" path also goes through this effect on
  // fresh mount.
  //
  // The document string is built only when it is actually assigned, and the
  // "did anything change" check compares the inputs (usually the identical
  // string instance from the model) instead of reading back the potentially
  // multi-megabyte `srcdoc` attribute on every render.
  const assignedRef = useRef<{ source: string; baseTag: string } | null>(null);
  useEffect(() => {
    const el = iframeRef.current;
    if (!el) return;
    const assigned = assignedRef.current;
    if (assigned && assigned.source === source && assigned.baseTag === baseTag) return;
    const assign = () => {
      assignedRef.current = { source, baseTag };
      el.srcdoc = injectPreamble(source, baseTag, buildScrollMeta(scrollByFile.get(scrollKey)));
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
        sandbox="allow-scripts allow-popups allow-forms allow-modals"
        allow=""
        referrerPolicy="no-referrer"
        title={t("preview.html_title")}
        className="w-full flex-1 border-0 bg-[var(--surface-island-bg)]"
      />
    </div>
  );
}
