import path from "node:path";
import { fileURLToPath } from "node:url";
import { PREVIEW_SCHEME } from "../../../shared/preview/document-url";

const BASE_DIRECTIVES: Readonly<Record<string, readonly string[]>> = {
  "default-src": ["'self'"],
  "script-src": ["'self'", "'wasm-unsafe-eval'"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:", "blob:", "nexus-workspace:", "https:", "http:"],
  "font-src": ["'self'", "data:", "blob:", "nexus-workspace:"],
  "media-src": ["'self'", "data:", "blob:", "nexus-workspace:"],
  "connect-src": ["'self'", "data:", "blob:"],
  "worker-src": ["'self'", "blob:"],
  "frame-src": [`${PREVIEW_SCHEME}:`],
  "object-src": ["'none'"],
  "base-uri": ["'none'"],
  "form-action": ["'none'"],
  "frame-ancestors": ["'none'"],
};

const DEV_DIRECTIVES: Readonly<Record<string, readonly string[]>> = {
  "script-src": ["'unsafe-inline'"],
  "connect-src": ["ws://localhost:*", "ws://127.0.0.1:*"],
};

export function appContentSecurityPolicy(devServerUrl?: string): string {
  const directives = new Map<string, string[]>();
  for (const [name, sources] of Object.entries(BASE_DIRECTIVES)) directives.set(name, [...sources]);
  if (devServerUrl !== undefined) {
    for (const [name, sources] of Object.entries(DEV_DIRECTIVES)) {
      directives.get(name)?.push(...sources);
    }
  }
  return [...directives].map(([name, sources]) => `${name} ${sources.join(" ")}`).join("; ");
}

export interface AppPage {
  readonly indexPath: string;
  readonly devServerUrl?: string;
}

function comparablePath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(a: string, b: string): boolean {
  return comparablePath(a) === comparablePath(b);
}

function isInsideDir(file: string, dir: string): boolean {
  const relative = path.relative(comparablePath(dir), comparablePath(file));
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

const FILE_CODE_TYPES = new Set([
  "mainFrame",
  "subFrame",
  "script",
  "stylesheet",
  "object",
  "xhr",
  "other",
]);

export function cancelsAppFileRequest(
  resourceType: string,
  url: string,
  rendererDir: string,
): boolean {
  if (!FILE_CODE_TYPES.has(resourceType)) return false;
  let file: string;
  try {
    file = fileURLToPath(url);
  } catch {
    return true;
  }
  return !isInsideDir(file, rendererDir);
}

export function isAppPageUrl(url: string, page: AppPage): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (page.devServerUrl !== undefined) {
    try {
      return parsed.origin === new URL(page.devServerUrl).origin;
    } catch {
      return false;
    }
  }
  if (parsed.protocol !== "file:") return false;
  try {
    return samePath(fileURLToPath(parsed), page.indexPath);
  } catch {
    return false;
  }
}

export function appPageUrlPatterns(page: AppPage): string[] {
  if (page.devServerUrl === undefined) return ["file:///*"];
  try {
    return [`${new URL(page.devServerUrl).origin}/*`];
  } catch {
    return [];
  }
}

export function cspHeaderName(reportOnly: boolean): string {
  return reportOnly ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy";
}
