import { createLogger } from "../../shared/log/renderer";

const log = createLogger("csp");

export const MAX_REPORTS = 50;

const MAX_URI_CHARS = 200;

export type CspViolation = Pick<
  SecurityPolicyViolationEvent,
  "effectiveDirective" | "blockedURI" | "disposition" | "sourceFile" | "lineNumber"
>;

const EXCALIDRAW_FONT_FALLBACK = "https://esm.sh/@excalidraw/excalidraw";

export function isExpectedViolation(violation: CspViolation): boolean {
  return (
    violation.effectiveDirective === "font-src" &&
    violation.blockedURI.startsWith(EXCALIDRAW_FONT_FALLBACK)
  );
}

export function describeViolation(violation: CspViolation): string {
  const verb = violation.disposition === "report" ? "would block" : "blocked";
  const uri = violation.blockedURI || "inline code";
  const shown = uri.length > MAX_URI_CHARS ? `${uri.slice(0, MAX_URI_CHARS)}…` : uri;
  const where = violation.sourceFile ? ` (${violation.sourceFile}:${violation.lineNumber})` : "";
  return `Content-Security-Policy ${verb} ${violation.effectiveDirective}: ${shown}${where}`;
}

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
