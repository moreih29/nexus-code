import { randomBytes } from "node:crypto";
import type { CustomScheme } from "electron";
// Namespace import, as nexus-workspace.ts explains: bun's electron shim has
// no named exports, and protocol is read only inside functions.
import * as electron from "electron";
import { ipcContract } from "../../../shared/ipc/contract";
import { createLogger } from "../../../shared/log/main";
import { PREVIEW_SCHEME, previewDocumentUrl } from "../../../shared/preview/document-url";
import { type CallContext, register, validateArgs } from "../../infra/ipc-router";

// ---------------------------------------------------------------------------
// nexus-preview:// — the documents of the HTML preview.
//
// The preview used to hand its document to the iframe as srcdoc. A srcdoc
// document takes on the Content-Security-Policy of the window that holds it,
// and the app window's is strict: a previewed page's inline scripts and CDN
// libraries would stop. So the renderer puts the document here and points the
// iframe at its address; a document of a scheme of its own carries only the
// policy of its response, PREVIEW_DOCUMENT_CSP.
//
// The iframe keeps its sandbox (no allow-same-origin): the page runs at an
// opaque origin whatever its scheme, and talks to the app only by
// postMessage, as before.
// ---------------------------------------------------------------------------

const logger = createLogger("nexus-preview");

/**
 * The policy a previewed page runs under: what it would get opened in a
 * browser — its own and CDN scripts, inline and eval'd code, styles, images,
 * fonts, media and connections anywhere on the network, and the workspace
 * files beside it (nexus-workspace://, which read guards of its own keep to
 * what a page renders with). Left out are the app's other schemes and the
 * disk (file:).
 */
export const PREVIEW_DOCUMENT_CSP =
  "default-src * data: blob: nexus-workspace: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'";

/**
 * The scheme's privileges, registered with the app's other schemes before
 * `app.whenReady()` (app-schemes.ts). Standard, so a token is the address's
 * host; secure, so a page is a secure context as it was in a srcdoc frame of
 * the app (the clipboard API asks for one). No fetch or CORS: only an iframe
 * loads a document (cancelsPreviewRequest).
 */
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

/**
 * How many documents one window holds. A pane holds one and lets go of it
 * when it closes, and a window lets go of all of its own when its page goes
 * (releaseWithPage), so a window holds one per preview open in it. Past this
 * a new document is refused, not made room for: each one held is an open
 * pane's, whose frame would come up blank once it moved or reloaded.
 */
export const MAX_DOCUMENTS_PER_OWNER = 32;

const TOKEN_PATTERN = /^[0-9a-f]{32}$/;

interface PreviewDocument {
  readonly owner: number;
  html: string;
}

/**
 * The documents the preview panes of each window put, by the token that
 * names each one. A pane puts its document again as it is edited, under the
 * same token, and releases it when it closes; a window's go when its page
 * does.
 */
export class PreviewDocuments {
  private readonly documents = new Map<string, PreviewDocument>();

  constructor(private readonly newToken: () => string = () => randomBytes(16).toString("hex")) {}

  /**
   * Puts `html` under `token` when `owner` holds that token, and under a new
   * one otherwise; returns the token it is under. Throws when a new one would
   * take `owner` past MAX_DOCUMENTS_PER_OWNER.
   */
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

  /** Lets go of `token`, when `owner` holds it. */
  release(owner: number, token: string): void {
    if (this.documents.get(token)?.owner === owner) this.documents.delete(token);
  }

  /** Lets go of every document of `owner`. */
  releaseOwner(owner: number): void {
    for (const [token, document] of this.documents) {
      if (document.owner === owner) this.documents.delete(token);
    }
  }

  /** The document `token` names. */
  get(token: string): string | undefined {
    return this.documents.get(token)?.html;
  }

  /** How many documents there are, of `owner` or in all. */
  size(owner?: number): number {
    if (owner === undefined) return this.documents.size;
    let count = 0;
    for (const document of this.documents.values()) if (document.owner === owner) count++;
    return count;
  }
}

/** Response headers of a preview document. */
function documentHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    // A document is put again on every edit: never one kept from before.
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": PREVIEW_DOCUMENT_CSP,
  };
}

/**
 * The protocol handler: `nexus-preview://<token>/` is the document the token
 * names. Anything else is a 404. Exported for tests.
 */
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

/**
 * Whether a request of `resourceType` for a preview document is cancelled:
 * all but an iframe's. Script, fetch or a window of the app's own would read
 * or run a document that only a sandboxed frame should.
 */
export function cancelsPreviewRequest(resourceType: string): boolean {
  return resourceType !== "subFrame";
}

/**
 * Installs the `nexus-preview://` handler on the app's session. Must be called
 * after `app.whenReady()`.
 */
export function installNexusPreviewProtocol(documents: PreviewDocuments): void {
  electron.protocol.handle(PREVIEW_SCHEME, buildNexusPreviewHandler(documents));
}

/** The window a call came from, by its webContents' id; -1 for none (tests). */
function ownerOf(ctx: CallContext | undefined): number {
  return ctx?.sender?.id ?? -1;
}

/**
 * The preview channel's handlers. `watchOwner` is called with the sender of
 * every put, to let go of its documents when it is gone.
 */
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

/** The events of a window's webContents that end its page. */
export interface PreviewOwner {
  readonly id: number;
  on(event: "did-navigate" | "render-process-gone", listener: () => void): unknown;
  once(event: "destroyed", listener: () => void): unknown;
}

/**
 * Lets go of `owner`'s documents when its page goes: its main frame commits
 * a page anew (Ctrl+R, a reload after a crash, the dev server's full reload),
 * its renderer is gone, or it closes. No pane of the page that comes next
 * holds them; its panes put their own.
 *
 * On did-navigate, not did-start-navigation: that comes before will-navigate,
 * so it comes too for a navigation the window's guard then cancels
 * (window/index.ts), and the page it would release for stays.
 * did-navigate is the main frame's only, and not an in-page one's.
 */
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

/** Registers the preview channel, whose documents a window's own lose when its page goes. */
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
