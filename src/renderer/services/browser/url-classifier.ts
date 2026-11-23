export type UrlClassifierKind = "navigate" | "search" | "blocked";

export interface UrlClassifierResult {
  kind: UrlClassifierKind;
  url: string;
  error?: string;
}

const BLOCKED_SCHEME_RE = /^(about:|javascript:|data:)/i;

const EXPLICIT_HTTP_RE = /^(https?|file):\/\//i;

const LOCAL_ADDRESS_RE = /^(localhost|127\.0\.0\.1|(?:\d{1,3}\.){3}\d{1,3})(:\d+)?(\/.*)?$/i;

const DOMAIN_LIKE_RE = /^[^\s]+\.[a-zA-Z]{2,6}(:\d+)?(\/.*)?$/;

export function classifyUrl(raw: string): UrlClassifierResult {
  const input = raw.trim();

  if (!input) {
    return { kind: "search", url: "https://www.google.com/search?q=" };
  }

  if (BLOCKED_SCHEME_RE.test(input)) {
    const scheme = input.split(":")[0]?.toLowerCase() ?? input;
    return {
      kind: "blocked",
      url: input,
      error: `"${scheme}:" URLs are not allowed in the browser tab.`,
    };
  }

  if (EXPLICIT_HTTP_RE.test(input)) {
    return { kind: "navigate", url: input };
  }

  if (input.startsWith("/")) {
    return { kind: "navigate", url: `file://${input}` };
  }

  if (LOCAL_ADDRESS_RE.test(input)) {
    return { kind: "navigate", url: `http://${input}` };
  }

  if (DOMAIN_LIKE_RE.test(input)) {
    const slashIdx = input.indexOf("/");
    const dotIdx = input.indexOf(".");
    if (slashIdx === -1 || dotIdx < slashIdx) {
      return { kind: "navigate", url: `https://${input}` };
    }
  }

  return {
    kind: "search",
    url: `https://www.google.com/search?q=${encodeURIComponent(input)}`,
  };
}
