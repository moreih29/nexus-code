import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { net, protocol } from "electron";
import { createLogger } from "../../../shared/log/main";
import type { WorkspaceManager } from "../workspace/manager";

const logger = createLogger("nexus-workspace");

// ---------------------------------------------------------------------------
// MIME type mapping — v1 covers image formats only.
// New entries should be added here when additional media types are needed.
// ---------------------------------------------------------------------------

const MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
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

    // Step 3 — SSH workspaces are not supported in v1.
    if (meta.location.kind !== "local") {
      logger.warn(`Remote workspace not supported (v1): ${workspaceId}`);
      return new Response(null, { status: 404 });
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
      const fileResp = await net.fetch(fileUrl);
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
// Public wiring API
// ---------------------------------------------------------------------------

/**
 * Registers the `nexus-workspace` scheme as a privileged standard scheme.
 * Must be called **before** `app.whenReady()`.
 */
export function registerNexusWorkspaceSchemes(): void {
  protocol.registerSchemesAsPrivileged([
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
  protocol.handle("nexus-workspace", buildNexusWorkspaceHandler(workspaceManager));
}
