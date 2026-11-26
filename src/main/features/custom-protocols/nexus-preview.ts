import { randomBytes } from "node:crypto";
import type { CustomScheme } from "electron";
import * as electron from "electron";
import { peerOf } from "../../../shared/fs/peer-url";
import { ipcContract } from "../../../shared/ipc/contract";
import { createLogger } from "../../../shared/log/main";
import { PREVIEW_SCHEME, previewDocumentUrl } from "../../../shared/preview/document-url";
import { previewScopeSource, previewScopeUrl } from "../../../shared/preview/scope-url";
import { type CallContext, register, validateArgs } from "../../infra/ipc-router";
import { isWindowsNetworkPath } from "../fs/outside-grants";
import { isBroadDir, type PreviewScopes, realpathNative } from "./preview-scopes";

const logger = createLogger("nexus-preview");

export function previewDocumentCsp(scope?: string): string {
  const own = scope ? ` ${previewScopeSource(scope)}` : "";
  const loads = `https: data: blob:${own}`;
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${loads}`,
    `style-src 'unsafe-inline' ${loads}`,
    `img-src ${loads}`,
    `font-src ${loads}`,
    `media-src ${loads}`,
    `connect-src ${scope ? previewScopeSource(scope) : "'none'"}`,
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "manifest-src 'none'",
    "form-action 'none'",
    `base-uri ${scope ? previewScopeSource(scope) : "'none'"}`,
  ].join("; ");
}

export const PREVIEW_DOCUMENT_CSP = previewDocumentCsp();

export const NEXUS_PREVIEW_SCHEME: CustomScheme = {
  scheme: PREVIEW_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: false,
    corsEnabled: false,
    bypassCSP: false,
  },
};

export const MAX_DOCUMENTS_PER_OWNER = 32;

const TOKEN_PATTERN = /^[0-9a-f]{32}$/;

interface PreviewDocument {
  readonly owner: number;
  html: string;
  scope?: string;
}

export class PreviewDocuments {
  private readonly documents = new Map<string, PreviewDocument>();

  constructor(private readonly newToken: () => string = () => randomBytes(16).toString("hex")) {}

  put(owner: number, html: string, token?: string, scope?: string): string {
    const held = token === undefined ? undefined : this.documents.get(token);
    if (token !== undefined && held?.owner === owner) {
      held.html = html;
      held.scope = scope;
      return token;
    }
    if (this.size(owner) >= MAX_DOCUMENTS_PER_OWNER) {
      throw new Error(`A window holds at most ${MAX_DOCUMENTS_PER_OWNER} preview documents`);
    }
    const minted = this.newToken();
    this.documents.set(minted, { owner, html, ...(scope ? { scope } : {}) });
    return minted;
  }

  release(owner: number, token: string): void {
    if (this.documents.get(token)?.owner === owner) this.documents.delete(token);
  }

  releaseOwner(owner: number): void {
    for (const [token, document] of this.documents) {
      if (document.owner === owner) this.documents.delete(token);
    }
  }

  get(token: string): string | undefined {
    return this.documents.get(token)?.html;
  }

  scopeOf(token: string): string | undefined {
    return this.documents.get(token)?.scope;
  }

  size(owner?: number): number {
    if (owner === undefined) return this.documents.size;
    let count = 0;
    for (const document of this.documents.values()) if (document.owner === owner) count++;
    return count;
  }
}

function documentHeaders(scope?: string): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": previewDocumentCsp(scope),
  };
}

export function buildNexusPreviewHandler(documents: PreviewDocuments): (req: Request) => Response {
  return (req) => {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return new Response(null, { status: 404 });
    }
    const token = url.hostname;
    const html =
      req.method === "GET" && url.pathname === "/" && TOKEN_PATTERN.test(token)
        ? documents.get(token)
        : undefined;
    if (html === undefined) return new Response(null, { status: 404 });
    return new Response(html, { status: 200, headers: documentHeaders(documents.scopeOf(token)) });
  };
}

export function cancelsPreviewRequest(resourceType: string): boolean {
  return resourceType !== "subFrame";
}

export function installNexusPreviewProtocol(documents: PreviewDocuments): void {
  electron.protocol.handle(PREVIEW_SCHEME, buildNexusPreviewHandler(documents));
}

function ownerOf(ctx: CallContext | undefined): number {
  return ctx?.sender?.id ?? -1;
}

async function isBroadRealDir(workspaceId: string, dir: string, home: string): Promise<boolean> {
  if (peerOf(workspaceId)) return false;
  const real = await realpathNative(dir).catch(() => null);
  if (real === null) return false;
  const realHome = home ? await realpathNative(home).catch(() => home) : home;
  return isBroadDir(real, home) || isBroadDir(real, realHome);
}

export function previewHandlers(
  documents: PreviewDocuments,
  watchOwner: (ctx: CallContext | undefined) => void = () => {},
  scopes?: PreviewScopes,
  home = "",
) {
  return {
    putHtml: (args: unknown, ctx?: CallContext) => {
      const { token, html, scope } = validateArgs(ipcContract.preview.call.putHtml.args, args);
      watchOwner(ctx);
      const owner = ownerOf(ctx);
      const held = documents.put(
        owner,
        html,
        token,
        scope && scopes?.heldBy(owner, scope) ? scope : undefined,
      );
      return { token: held, url: previewDocumentUrl(held) };
    },
    openScope: async (args: unknown, ctx?: CallContext) => {
      const { workspaceId, dir } = validateArgs(ipcContract.preview.call.openScope.args, args);
      watchOwner(ctx);
      if (!scopes) return null;
      if (!isWindowsNetworkPath(dir) && (await isBroadRealDir(workspaceId, dir, home))) return null;
      const id = scopes.open(ownerOf(ctx), workspaceId, dir);
      return id ? { scope: id, base: previewScopeUrl(id) } : null;
    },
    releaseHtml: (args: unknown, ctx?: CallContext) => {
      const { token } = validateArgs(ipcContract.preview.call.releaseHtml.args, args);
      documents.release(ownerOf(ctx), token);
    },
  };
}

export interface PreviewOwner {
  readonly id: number;
  on(event: "did-navigate" | "render-process-gone", listener: () => void): unknown;
  once(event: "destroyed", listener: () => void): unknown;
}

export function releaseWithPage(
  documents: PreviewDocuments,
  owner: PreviewOwner,
  scopes?: PreviewScopes,
): void {
  const id = owner.id;
  const release = (why: string) => {
    scopes?.releaseOwner(id);
    if (documents.size(id) === 0) return;
    documents.releaseOwner(id);
    logger.debug(`Released the preview documents of webContents ${id}: ${why}`);
  };
  owner.on("did-navigate", () => release("its page navigated"));
  owner.on("render-process-gone", () => release("its renderer is gone"));
  owner.once("destroyed", () => release("it closed"));
}

export function registerPreviewChannel(
  documents: PreviewDocuments,
  scopes: PreviewScopes,
  home: string,
): void {
  const watched = new WeakSet<object>();
  register("preview", {
    call: previewHandlers(
      documents,
      (ctx) => {
        const sender = ctx?.sender;
        if (!sender || watched.has(sender)) return;
        watched.add(sender);
        releaseWithPage(documents, sender, scopes);
      },
      scopes,
      home,
    ),
    listen: {},
  });
}
