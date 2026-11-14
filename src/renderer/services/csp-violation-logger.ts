/**
 * Logs what the app window's Content-Security-Policy blocks (main's
 * window/app-csp.ts), to the main process's log file through the shared log
 * facade: a feature the policy breaks in a release shows up there, not only in
 * a console nobody has open. In Report-Only (NEXUS_CSP_REPORT_ONLY=1) it logs
 * what the policy would block.
 *
 * Each directive and address is logged once, and a page logs at most
 * MAX_REPORTS: a page that keeps hitting the policy would flood the log. A
 * violation the policy is meant to cause (isExpectedViolation) is not logged.
 */

import { createLogger } from "../../shared/log/renderer";

const log = createLogger("csp");

export const MAX_REPORTS = 50;

/** How much of a blocked address is logged: a data: URL can be the whole image. */
const MAX_URI_CHARS = 200;

/** The parts of a securitypolicyviolation event the log takes. */
export type CspViolation = Pick<
  SecurityPolicyViolationEvent,
  "effectiveDirective" | "blockedURI" | "disposition" | "sourceFile" | "lineNumber"
>;

/**
 * Where Excalidraw falls back to for its fonts. Each of its font faces lists
 * the copy the app ships (notes/editor/excalidraw-assets.ts) and then this
 * CDN; the browser checks every source against the policy when the face is
 * made, so a sketch reports ~50 of these, though it fetches the CDN only when
 * the shipped copy fails to load (and the policy blocks that).
 */
const EXCALIDRAW_FONT_FALLBACK = "https://esm.sh/@excalidraw/excalidraw";

/** A violation the policy is meant to cause, which says nothing is broken. */
export function isExpectedViolation(violation: CspViolation): boolean {
  return (
    violation.effectiveDirective === "font-src" &&
    violation.blockedURI.startsWith(EXCALIDRAW_FONT_FALLBACK)
  );
}

/** One log line for `violation`. */
export function describeViolation(violation: CspViolation): string {
  const verb = violation.disposition === "report" ? "would block" : "blocked";
  const uri = violation.blockedURI || "inline code";
  const shown = uri.length > MAX_URI_CHARS ? `${uri.slice(0, MAX_URI_CHARS)}…` : uri;
  const where = violation.sourceFile ? ` (${violation.sourceFile}:${violation.lineNumber})` : "";
  return `Content-Security-Policy ${verb} ${violation.effectiveDirective}: ${shown}${where}`;
}

/**
 * Logs each violation `target` reports, as above; returns what removes the
 * listener.
 */
export function installCspViolationLogger(
  target: Pick<EventTarget, "addEventListener" | "removeEventListener"> = document,
  warn: (line: string) => void = (line) => log.warn(line),
): () => void {
  const seen = new Set<string>();
  const onViolation = (event: Event) => {
    const violation = event as SecurityPolicyViolationEvent;
    if (isExpectedViolation(violation)) return;
    const key = `${violation.effectiveDirective} ${violation.blockedURI}`;
    if (seen.has(key) || seen.size >= MAX_REPORTS) return;
    seen.add(key);
    warn(describeViolation(violation));
  };
  target.addEventListener("securitypolicyviolation", onViolation);
  return () => target.removeEventListener("securitypolicyviolation", onViolation);
}
