import { randomBytes } from "node:crypto";
import type { CustomScheme } from "electron";
import * as electron from "electron";
import { ipcContract } from "../../../shared/ipc/contract";
import { createLogger } from "../../../shared/log/main";
import { PREVIEW_SCHEME, previewDocumentUrl } from "../../../shared/preview/document-url";
import { type CallContext, register, validateArgs } from "../../infra/ipc-router";

const logger = createLogger("nexus-preview");

export const PREVIEW_DOCUMENT_CSP =
  "default-src * data: blob: nexus-workspace: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'";

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
}

export class PreviewDocuments {
  private readonly documents = new Map<string, PreviewDocument>();

  constructor(private readonly newToken: () => string = () => randomBytes(16).toString("hex")) {}

  put(owner: number, html: string, token?: string): string {
    const held = token === undefined ? undefined : this.documents.get(token);
    if (token !== undefined && held?.owner === owner) {
      held.html = html;
      return token;
    }
    if (this.size(owner) >= MAX_DOCUMENTS_PER_OWNER) {
      throw new Error(`A window holds at most ${MAX_DOCUMENTS_PER_OWNER} preview documents`);
    }
    const minted = this.newToken();
    this.documents.set(minted, { owner, html });
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

  size(owner?: number): number {
    if (owner === undefined) return this.documents.size;
    let count = 0;
    for (const document of this.documents.values()) if (document.owner === owner) count++;
    return count;
  }
}

function documentHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": PREVIEW_DOCUMENT_CSP,
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
    return new Response(html, { status: 200, headers: documentHeaders() });
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

export function previewHandlers(
  documents: PreviewDocuments,
  watchOwner: (ctx: CallContext | undefined) => void = () => {},
) {
  return {
    putHtml: (args: unknown, ctx?: CallContext) => {
      const { token, html } = validateArgs(ipcContract.preview.call.putHtml.args, args);
      watchOwner(ctx);
      const held = documents.put(ownerOf(ctx), html, token);
      return { token: held, url: previewDocumentUrl(held) };
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

export function releaseWithPage(documents: PreviewDocuments, owner: PreviewOwner): void {
  const id = owner.id;
  const release = (why: string) => {
    if (documents.size(id) === 0) return;
    documents.releaseOwner(id);
    logger.debug(`Released the preview documents of webContents ${id}: ${why}`);
  };
  owner.on("did-navigate", () => release("its page navigated"));
  owner.on("render-process-gone", () => release("its renderer is gone"));
  owner.once("destroyed", () => release("it closed"));
}

export function registerPreviewChannel(documents: PreviewDocuments): void {
  const watched = new WeakSet<object>();
  register("preview", {
    call: previewHandlers(documents, (ctx) => {
      const sender = ctx?.sender;
      if (!sender || watched.has(sender)) return;
      watched.add(sender);
      releaseWithPage(documents, sender);
    }),
    listen: {},
  });
}
