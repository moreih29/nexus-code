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
//
//   Absent tokens we deliberately keep off:
//     - `allow-same-origin` → iframe at opaque origin; no cross-talk with
//                             our renderer's globals or storage.
//     - `allow-top-navigation` → cannot navigate the outer window.
//     - `allow-forms` / `allow-modals` / `allow-downloads` / `allow-popups-
//        to-escape-sandbox` → keep workspace HTML on the same restricted
//                              floor as scripts inside it.
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
//   document inherits two host behaviours:
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
// SRCDOC RELOAD (plan 60 follow-up — toggle bug)
//   Some Chromium builds do not reload the iframe when its `srcDoc` prop
//   changes from "" to a real value; the document parser is not re-invoked
//   in place. The result: toggling preview→raw→preview can leave a blank
//   pane. We force a fresh document each time `text` changes by using
//   `key={…}` so React mounts a brand-new <iframe> element and the parser
//   runs from scratch.

import { useEffect, useRef } from "react";
import { isWithinWorkspace, relPath } from "@/utils/path";
import { buildWorkspaceDirUrl } from "../../../services/editor/preview/workspace-url";
import { useTranslation } from "react-i18next";
import { capPreviewSource, getPreviewTruncatedMessage } from "./constants";

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
})();
</script>`;

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
 * (which follow inside their <head>) resolve against it.
 */
function injectPreamble(source: string, baseTag: string): string {
  const head = baseTag + HTML_PREVIEW_PREAMBLE;
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
  const { text, truncated } = capPreviewSource(source);
  const baseTag = buildBaseTag(workspaceId, currentFileAbsPath, workspaceRootAbsPath);
  const doc = injectPreamble(text, baseTag);

  // Imperatively set `srcdoc` so the iframe element stays mounted across
  // live edits (no remount cascade). The known Chromium srcDoc-prop-not-
  // reloading bug is side-stepped because we touch the DOM attribute
  // directly — the browser reliably re-parses on assignment. PreviewPane
  // already unmounts/remounts HtmlPreview around the raw↔preview toggle,
  // so the "empty → first content" path also goes through this effect on
  // fresh mount.
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  useEffect(() => {
    const el = iframeRef.current;
    if (!el) return;
    if (el.srcdoc !== doc) el.srcdoc = doc;
  }, [doc]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {truncated && <PreviewTruncatedBanner />}
      <iframe
        ref={iframeRef}
        sandbox="allow-scripts allow-popups"
        allow=""
        referrerPolicy="no-referrer"
        title={t("preview.html_title")}
        className="w-full flex-1 border-0 bg-[var(--surface-island-bg)]"
      />
    </div>
  );
}

function PreviewTruncatedBanner() {
  return (
    <div
      role="status"
      className="px-3 py-1 text-app-ui-sm text-[var(--state-warning-fg)] bg-[var(--state-warning-bg)] border-b border-[var(--state-warning-border)]"
    >
      {getPreviewTruncatedMessage()}
    </div>
  );
}
