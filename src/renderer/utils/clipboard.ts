/**
 * Renderer-side clipboard helper.
 *
 * Wraps `navigator.clipboard.writeText` with a fire-and-forget call. The
 * Electron renderer is a secure context so the modern clipboard API is
 * available; we deliberately don't fall back to `document.execCommand`
 * because we never run in a non-secure context.
 *
 * Failure modes (permission denied, document not focused) currently
 * surface as silent rejections — copy is non-destructive and the user
 * notices missing paste content quickly. When we add a toast channel for
 * other actions (Reveal in Finder, Rename, Delete) this helper is the
 * single place to wire failure feedback.
 */
export function copyText(text: string): void {
  void navigator.clipboard.writeText(text);
}
