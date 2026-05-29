import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
// Namespace import (not `import { net, protocol }`): under Bun's test runtime
// the real electron entry is a CJS shim with no named exports, so a static
// named import fails to link with "Export named 'protocol' not found" — an
// error bun surfaces as a flake "between tests". A namespace import has no
// link-time named-export requirement; net/protocol are only dereferenced
// inside the functions below (never at module load), so this is behavior-
// equivalent in the real electron runtime.
import * as electron from "electron";
import { createLogger } from "../../../shared/log/main";
import type { WorkspaceManager } from "../workspace/manager";

const logger = createLogger("nexus-workspace");

// ---------------------------------------------------------------------------
// MIME type mapping — v1 covers image formats only.
// New entries should be added here when additional media types are needed.
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
};

function mimeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] ?? "application/octet-stream";
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

    const workspaceId = parsed.host;
    // pathname always starts with "/" — strip it and decode each segment.
    const relPath = parsed.pathname.slice(1).split("/").map(decodeURIComponent).join(path.sep);

    // Step 2 — look up the workspace meta.
    const metas = workspaceManager.list();
    const meta = metas.find((m) => m.id === workspaceId);
    if (!meta) {
      logger.warn(`Workspace not found: ${workspaceId}`);
      return new Response(null, { status: 404 });
    }

    // SSH workspaces are served through the agent's fs.readBinary method.
    // Local workspaces stay on the file:// fetch path below because it
    // streams directly off disk without a base64 round-trip.
    if (meta.location.kind !== "local") {
      return serveViaAgent(workspaceManager, workspaceId, relPath);
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

    // Step 6 — serve via net.fetch using a file:// URL.
    // net.fetch handles streaming for us and avoids manually wrapping Node
    // streams into a Web ReadableStream across Electron versions.
    const contentType = mimeFromPath(realPath);
    try {
      const fileUrl = pathToFileURL(realPath).href;
      const fileResp = await electron.net.fetch(fileUrl);
      if (!fileResp.ok) {
        logger.warn(`net.fetch failed (${fileResp.status}): ${realPath}`);
        return new Response(null, { status: 404 });
      }
      return new Response(fileResp.body, {
        status: 200,
        headers: { "Content-Type": contentType },
      });
    } catch (err) {
      logger.warn(`Failed to read file: ${realPath} — ${(err as Error).message}`);
      return new Response(null, { status: 404 });
    }
  };
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
): Promise<Response> {
  // posix-style for the agent (it splits on "/" internally and runs on
  // unix hosts in SSH mode). path.sep was applied at parse time for the
  // local branch — undo it here so the wire path stays portable.
  const posixRelPath = relPath.split(path.sep).join("/");
  let fsProvider: Awaited<ReturnType<WorkspaceManager["getFs"]>>;
  try {
    fsProvider = await workspaceManager.getFs(workspaceId);
  } catch (err) {
    logger.warn(`SSH workspace fs unavailable: ${workspaceId} — ${(err as Error).message}`);
    return new Response(null, { status: 503 });
  }

  try {
    const result = await fsProvider.readBinary(posixRelPath);
    if (result.kind === "missing") {
      return new Response(null, { status: 404 });
    }
    const buf = Buffer.from(result.base64, "base64");
    const contentType = mimeFromPath(posixRelPath);
    return new Response(buf, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
      },
    });
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
        corsEnabled: false,
        bypassCSP: false,
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
}
