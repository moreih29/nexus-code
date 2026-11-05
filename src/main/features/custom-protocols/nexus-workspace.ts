import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
// Namespace import (not `import { net, protocol }`): under Bun's test runtime
// the real electron entry is a CJS shim with no named exports, so a static
// named import fails to link with "Export named 'protocol' not found" — an
// error bun surfaces as a flake "between tests". A namespace import has no
// link-time named-export requirement; net/protocol are only dereferenced
// inside the functions below (never at module load), so this is behavior-
// equivalent in the real electron runtime.
import * as electron from "electron";
import { outsideWorkspaceOf } from "../../../shared/fs/outside-url";
import { createLogger } from "../../../shared/log/main";
import { isScriptReadableRequest } from "../../infra/security/script-readable-request";
import { isOutsideGranted, resolveOutsideGrant } from "../fs/outside-grants";
import type { WorkspaceManager } from "../workspace/manager";

const logger = createLogger("nexus-workspace");

// ---------------------------------------------------------------------------
// MIME type mapping. New entries should be added here when additional media
// types are needed.
// ---------------------------------------------------------------------------

const MIME_MAP: Record<string, string> = {
  // Images
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  // Web assets — needed so the HTML preview can load relatively-referenced
  // sibling files (`<script src>`, `<link rel=stylesheet>`, fonts, …). The
  // preview iframe is at an opaque origin, so these load cross-origin: a
  // stylesheet served with the wrong MIME is REJECTED by Chromium and a
  // script may refuse to execute. Serving the correct type is what makes
  // sibling .js/.css resolve instead of 404-ing.
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  // Fonts
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  // Audio and video, which the editor plays in <audio> and <video>
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
};

function mimeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] ?? "application/octet-stream";
}

/** Response headers shared by the local and SSH branches. */
function responseHeaders(filePath: string): Record<string, string> {
  return {
    "Content-Type": mimeFromPath(filePath),
    // `no-store` is required, not just a hint: Blink's memory cache treats
    // non-http(s) responses without cache headers as fresh FOREVER, so an
    // image (or an HTML-preview sibling .css/.js) edited on disk would keep
    // rendering the first-fetched bytes for the life of the renderer.
    "Cache-Control": "no-store",
    // Stops a page from loading a non-JS/non-CSS file as a classic script or
    // stylesheet to read it (an `.env` of `KEY="…"` lines is valid JS).
    "X-Content-Type-Options": "nosniff",
    // <audio> and <video> seek by asking for the bytes at the new place.
    "Accept-Ranges": "bytes",
  };
}

/** The bytes a request asks for, from `start` to `end` inclusive. */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/**
 * The range a `Range` header asks of a file of `size` bytes: null for the
 * whole file (no header, or one this does not serve, as several ranges),
 * "unsatisfiable" for one that starts past the end.
 */
export function requestedRange(
  header: string | null,
  size: number,
): ByteRange | "unsatisfiable" | null {
  const match = header?.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  const [, from = "", to = ""] = match;
  if (from === "" && to === "") return null;
  if (size === 0) return "unsatisfiable";
  if (from === "") {
    // The last `to` bytes.
    const length = Number(to);
    if (length === 0) return "unsatisfiable";
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(from);
  if (start >= size) return "unsatisfiable";
  const end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  if (end < start) return null;
  return { start, end };
}

/** A 206 for `range` of a file of `size` bytes, or the 416 for none in it. */
function partialResponse(
  body: ConstructorParameters<typeof Response>[0],
  range: ByteRange,
  size: number,
  filePath: string,
): Response {
  return new Response(body, {
    status: 206,
    headers: {
      ...responseHeaders(filePath),
      "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
      "Content-Length": String(range.end - range.start + 1),
    },
  });
}

function unsatisfiable(size: number): Response {
  return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
}

// ---------------------------------------------------------------------------
// Handler — exported for unit testing via dependency injection.
// ---------------------------------------------------------------------------

/**
 * Builds the protocol handler function.  Exported so tests can call it
 * directly without requiring a live Electron app context.
 */
export function buildNexusWorkspaceHandler(
  workspaceManager: WorkspaceManager,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    // Step 1 — parse the custom URL.
    let parsed: URL;
    try {
      parsed = new URL(req.url);
    } catch {
      logger.warn(`Invalid URL rejected: ${req.url}`);
      return new Response(null, { status: 404 });
    }

    // A file outside the workspace that a Claude tab linked has the
    // workspace's host with a suffix, and its absolute path.
    const outsideOf = outsideWorkspaceOf(parsed.host);
    const workspaceId = outsideOf ?? parsed.host;
    // pathname always starts with "/" — strip it and decode each segment.
    let segments: string[];
    try {
      segments = parsed.pathname.slice(1).split("/").map(decodeURIComponent);
    } catch {
      return new Response(null, { status: 404 });
    }
    const relPath = segments.join(path.sep);

    // Step 2 — look up the workspace meta.
    const metas = workspaceManager.list();
    const meta = metas.find((m) => m.id === workspaceId);
    if (!meta) {
      logger.warn(`Workspace not found: ${workspaceId}`);
      return new Response(null, { status: 404 });
    }

    if (outsideOf !== null) {
      const absPath = `/${segments.join("/")}`;
      if (meta.location.kind !== "local") {
        if (!isOutsideGranted(workspaceId, absPath)) {
          logger.warn(`Outside path not granted: ${req.url}`);
          return new Response(null, { status: 404 });
        }
        return serveViaAgent(workspaceManager, workspaceId, absPath, req.headers.get("range"));
      }
      const realPath = await resolveOutsideGrant(workspaceId, absPath);
      if (!realPath) {
        logger.warn(`Outside path not granted: ${req.url}`);
        return new Response(null, { status: 404 });
      }
      return serveLocalFile(realPath, req.headers.get("range"));
    }

    // SSH workspaces are served through the agent's fs.readBinary method.
    // Local workspaces stay on the file:// fetch path below because it
    // streams directly off disk without a base64 round-trip.
    if (meta.location.kind !== "local") {
      return serveViaAgent(workspaceManager, workspaceId, relPath, req.headers.get("range"));
    }

    const rootPath = meta.location.rootPath;

    // Step 4 — path traversal guard (.. escape).
    // Normalise with path.resolve so ".." segments are collapsed before the
    // prefix check.  Ensure the resolved path is strictly inside rootPath.
    const resolved = path.resolve(rootPath, relPath);
    const rootNorm = rootPath.endsWith(path.sep) ? rootPath : rootPath + path.sep;
    if (resolved !== rootPath && !resolved.startsWith(rootNorm)) {
      logger.warn(`Path traversal attempt rejected: ${req.url}`);
      return new Response(null, { status: 404 });
    }

    // Step 5 — symlink escape guard via realpath.
    let realPath: string;
    try {
      realPath = await fs.promises.realpath(resolved);
    } catch {
      logger.warn(`File not found or inaccessible: ${resolved}`);
      return new Response(null, { status: 404 });
    }

    const realRootNorm = rootPath.endsWith(path.sep) ? rootPath : rootPath + path.sep;
    // Also resolve the root itself to handle symlinked roots correctly.
    let realRoot: string;
    try {
      realRoot = await fs.promises.realpath(rootPath);
    } catch {
      logger.warn(`Workspace root not accessible: ${rootPath}`);
      return new Response(null, { status: 404 });
    }
    const realRootResolved = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;

    if (
      realPath !== realRoot &&
      !realPath.startsWith(realRootResolved) &&
      !realPath.startsWith(realRootNorm)
    ) {
      logger.warn(`Symlink escape rejected: ${realPath}`);
      return new Response(null, { status: 404 });
    }

    return serveLocalFile(realPath, req.headers.get("range"));
  };
}

/** A file on this machine, at a path already checked, whole or the range asked. */
async function serveLocalFile(realPath: string, rangeHeader: string | null): Promise<Response> {
  // Step 6 — a range, as <audio> and <video> ask for, is read from the
  // file at its place.
  if (rangeHeader !== null) {
    try {
      const { size } = await fs.promises.stat(realPath);
      const range = requestedRange(rangeHeader, size);
      if (range === "unsatisfiable") return unsatisfiable(size);
      if (range !== null) {
        const stream = fs.createReadStream(realPath, { start: range.start, end: range.end });
        const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
        return partialResponse(body, range, size, realPath);
      }
    } catch (err) {
      logger.warn(`Failed to read file: ${realPath} — ${(err as Error).message}`);
      return new Response(null, { status: 404 });
    }
  }

  // Step 7 — serve via net.fetch using a file:// URL.
  // net.fetch handles streaming for us and avoids manually wrapping Node
  // streams into a Web ReadableStream across Electron versions.
  try {
    const fileUrl = pathToFileURL(realPath).href;
    const fileResp = await electron.net.fetch(fileUrl);
    if (!fileResp.ok) {
      logger.warn(`net.fetch failed (${fileResp.status}): ${realPath}`);
      return new Response(null, { status: 404 });
    }
    return new Response(fileResp.body, { status: 200, headers: responseHeaders(realPath) });
  } catch (err) {
    logger.warn(`Failed to read file: ${realPath} — ${(err as Error).message}`);
    return new Response(null, { status: 404 });
  }
}

// ---------------------------------------------------------------------------
// SSH path — relays the workspace-relative file through the agent's
// fs.readBinary method. The agent already enforces workspace-bound path
// resolution (rejecting `..` and absolute paths) so we don't repeat the
// realpath/symlink dance here; the trust boundary lives on the remote end.
//
// Bytes arrive base64-encoded over the NDJSON channel; we decode to a Node
// Buffer and ship it as the Response body. `Cache-Control: no-store` keeps
// the renderer from caching across SSH reconnects where the same path may
// resolve to a different blob.
// ---------------------------------------------------------------------------

async function serveViaAgent(
  workspaceManager: WorkspaceManager,
  workspaceId: string,
  relPath: string,
  rangeHeader: string | null,
): Promise<Response> {
  // posix-style for the agent (it splits on "/" internally and runs on
  // unix hosts in SSH mode). path.sep was applied at parse time for the
  // local branch — undo it here so the wire path stays portable. An
  // absolute path is an outside file already checked against the grants.
  const posixRelPath = relPath.split(path.sep).join("/");
  const outside = posixRelPath.startsWith("/");
  let fsProvider: Awaited<ReturnType<WorkspaceManager["getFs"]>>;
  try {
    fsProvider = await workspaceManager.getFs(workspaceId);
  } catch (err) {
    logger.warn(`SSH workspace fs unavailable: ${workspaceId} — ${(err as Error).message}`);
    return new Response(null, { status: 503 });
  }

  try {
    const result = outside
      ? await fsProvider.readAbsoluteBinary(posixRelPath)
      : await fsProvider.readBinary(posixRelPath);
    if (result.kind === "missing") {
      return new Response(null, { status: 404 });
    }
    const buf = Buffer.from(result.base64, "base64");
    // The agent reads whole files; a range is cut from the bytes.
    const range = requestedRange(rangeHeader, buf.length);
    if (range === "unsatisfiable") return unsatisfiable(buf.length);
    if (range !== null) {
      return partialResponse(
        buf.subarray(range.start, range.end + 1),
        range,
        buf.length,
        posixRelPath,
      );
    }
    return new Response(buf, { status: 200, headers: responseHeaders(posixRelPath) });
  } catch (err) {
    logger.warn(
      `SSH readBinary failed: ${workspaceId}:${posixRelPath} — ${(err as Error).message}`,
    );
    return new Response(null, { status: 404 });
  }
}

// ---------------------------------------------------------------------------
// Public wiring API
// ---------------------------------------------------------------------------

/**
 * Registers the `nexus-workspace` scheme as a privileged standard scheme.
 * Must be called **before** `app.whenReady()`.
 */
export function registerNexusWorkspaceSchemes(): void {
  electron.protocol.registerSchemesAsPrivileged([
    {
      scheme: "nexus-workspace",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: false,
        // corsEnabled lets the preview iframe (opaque/"null" origin) load
        // resources that are fetched in CORS mode — @font-face fonts, which
        // the spec always requests as CORS even without `crossorigin`, and
        // module scripts. Without it Chromium blocks those cross-origin
        // loads regardless of response headers. It also makes every file
        // readable by XHR, which the read guard installed with the handler
        // cancels. supportFetchAPI stays false: no JS fetch() surface.
        corsEnabled: true,
        bypassCSP: false,
        // Lets <audio> and <video> play files as they load, and seek them.
        stream: true,
      },
    },
  ]);
}

/**
 * Installs the `nexus-workspace://` protocol handler.
 * Must be called **after** `app.whenReady()`.
 */
export function installNexusWorkspaceProtocol(workspaceManager: WorkspaceManager): void {
  electron.protocol.handle("nexus-workspace", buildNexusWorkspaceHandler(workspaceManager));
  // The HTML preview runs workspace pages (and whatever they navigate or
  // embed) in frames of the app's own session, where this scheme is
  // reachable; see isScriptReadableRequest.
  electron.session.defaultSession.webRequest.onBeforeRequest(
    { urls: ["nexus-workspace://*/*"] },
    (details, callback) => {
      const cancel = isScriptReadableRequest(details.resourceType, details.url);
      if (cancel) logger.warn(`Blocked script-readable ${details.resourceType}: ${details.url}`);
      callback({ cancel });
    },
  );
}
