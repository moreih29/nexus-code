import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  cancelsAppRequest,
  cancelsAppSchemeRequest,
} from "../../../../src/main/features/custom-protocols/app-schemes";
import {
  buildNexusPreviewHandler,
  cancelsPreviewRequest,
  MAX_DOCUMENTS_PER_OWNER,
  PREVIEW_DOCUMENT_CSP,
  PreviewDocuments,
  type PreviewOwner,
  previewHandlers,
  releaseWithPage,
} from "../../../../src/main/features/custom-protocols/nexus-preview";
import type { CallContext } from "../../../../src/main/infra/ipc-router";

/** Tokens in the shape main mints (32 hex digits), numbered. */
function tokens(): () => string {
  let next = 0;
  return () => (next++).toString(16).padStart(32, "0");
}

const WINDOW_A = 1;
const WINDOW_B = 2;

describe("PreviewDocuments", () => {
  test("puts a document under a new token, and again under the one it holds", () => {
    const documents = new PreviewDocuments(tokens());
    const token = documents.put(WINDOW_A, "<p>one</p>");
    expect(documents.get(token)).toBe("<p>one</p>");
    expect(documents.put(WINDOW_A, "<p>two</p>", token)).toBe(token);
    expect(documents.get(token)).toBe("<p>two</p>");
    expect(documents.size()).toBe(1);
  });

  test("gives a new token for one another window holds, or one let go of", () => {
    const documents = new PreviewDocuments(tokens());
    const token = documents.put(WINDOW_A, "<p>a</p>");
    const other = documents.put(WINDOW_B, "<p>b</p>", token);
    expect(other).not.toBe(token);
    expect(documents.get(token)).toBe("<p>a</p>");
    documents.release(WINDOW_A, token);
    expect(documents.put(WINDOW_A, "<p>c</p>", token)).not.toBe(token);
  });

  test("lets go of a token only for the window that holds it", () => {
    const documents = new PreviewDocuments(tokens());
    const token = documents.put(WINDOW_A, "<p>a</p>");
    documents.release(WINDOW_B, token);
    expect(documents.get(token)).toBe("<p>a</p>");
    documents.release(WINDOW_A, token);
    expect(documents.get(token)).toBeUndefined();
  });

  test("lets go of every document of a window that closed", () => {
    const documents = new PreviewDocuments(tokens());
    documents.put(WINDOW_A, "<p>1</p>");
    documents.put(WINDOW_A, "<p>2</p>");
    const kept = documents.put(WINDOW_B, "<p>3</p>");
    documents.releaseOwner(WINDOW_A);
    expect(documents.size(WINDOW_A)).toBe(0);
    expect(documents.get(kept)).toBe("<p>3</p>");
  });

  test("refuses a new document past a window's limit, and keeps every one it holds", () => {
    const documents = new PreviewDocuments(tokens());
    const held: string[] = [];
    for (let i = 0; i < MAX_DOCUMENTS_PER_OWNER; i++)
      held.push(documents.put(WINDOW_A, `doc ${i}`));
    expect(() => documents.put(WINDOW_A, "one more")).toThrow();
    expect(documents.size(WINDOW_A)).toBe(MAX_DOCUMENTS_PER_OWNER);
    for (const [i, token] of held.entries()) expect(documents.get(token)).toBe(`doc ${i}`);
    // A held one is still put again, another window still puts, and one let go of makes room.
    const first = held[0] ?? "";
    expect(documents.put(WINDOW_A, "doc 0 again", first)).toBe(first);
    expect(documents.get(first)).toBe("doc 0 again");
    expect(documents.get(documents.put(WINDOW_B, "b"))).toBe("b");
    documents.release(WINDOW_A, first);
    expect(documents.get(documents.put(WINDOW_A, "one more"))).toBe("one more");
  });
});

describe("releaseWithPage", () => {
  /** A webContents' page events, on a plain emitter. */
  function owner(id: number): EventEmitter & PreviewOwner {
    return Object.assign(new EventEmitter(), { id });
  }

  function holding(): { documents: PreviewDocuments; a: string; b: string } {
    const documents = new PreviewDocuments(tokens());
    documents.put(WINDOW_A, "<p>1</p>");
    const a = documents.put(WINDOW_A, "<p>2</p>");
    const b = documents.put(WINDOW_B, "<p>3</p>");
    return { documents, a, b };
  }

  for (const event of ["did-navigate", "render-process-gone", "destroyed"]) {
    test(`lets go of a window's documents on ${event}, and only its own`, () => {
      const { documents, a, b } = holding();
      const window = owner(WINDOW_A);
      releaseWithPage(documents, window);
      window.emit(event);
      expect(documents.size(WINDOW_A)).toBe(0);
      expect(documents.get(a)).toBeUndefined();
      expect(documents.get(b)).toBe("<p>3</p>");
    });
  }

  test("lets go of what the next page puts on its next navigation, not before", () => {
    const { documents } = holding();
    const window = owner(WINDOW_A);
    releaseWithPage(documents, window);
    window.emit("did-navigate");
    const next = documents.put(WINDOW_A, "<p>next page</p>");
    expect(documents.get(next)).toBe("<p>next page</p>");
    window.emit("did-navigate");
    expect(documents.get(next)).toBeUndefined();
  });
});

describe("buildNexusPreviewHandler", () => {
  function serve(documents: PreviewDocuments, url: string, method = "GET"): Response {
    return buildNexusPreviewHandler(documents)(new Request(url, { method }));
  }

  test("serves the document a token names, under the preview's policy", async () => {
    const documents = new PreviewDocuments(tokens());
    const token = documents.put(WINDOW_A, "<!DOCTYPE html><p>hi</p>");
    const response = serve(documents, `nexus-preview://${token}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<!DOCTYPE html><p>hi</p>");
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Security-Policy")).toBe(PREVIEW_DOCUMENT_CSP);
  });

  test("answers 404 for anything but a held token's document", () => {
    const documents = new PreviewDocuments(tokens());
    const token = documents.put(WINDOW_A, "<p>hi</p>");
    expect(serve(documents, `nexus-preview://${token}/other.html`).status).toBe(404);
    expect(serve(documents, `nexus-preview://${token}/`, "POST").status).toBe(404);
    expect(serve(documents, `nexus-preview://${"f".repeat(32)}/`).status).toBe(404);
    expect(serve(documents, "nexus-preview://not-a-token/").status).toBe(404);
    documents.release(WINDOW_A, token);
    expect(serve(documents, `nexus-preview://${token}/`).status).toBe(404);
  });

  test("the preview's policy lets a page run as in a browser, and keeps the disk out", () => {
    for (const source of ["*", "data:", "blob:", "nexus-workspace:", "'unsafe-inline'"]) {
      expect(PREVIEW_DOCUMENT_CSP).toContain(source);
    }
    expect(PREVIEW_DOCUMENT_CSP).not.toContain("file:");
  });
});

describe("the preview channel", () => {
  const ctx = (id: number) => ({ sender: { id } }) as unknown as CallContext;

  test("puts under the sender's window and returns the document's address", () => {
    const documents = new PreviewDocuments(tokens());
    const watched: number[] = [];
    const handlers = previewHandlers(documents, (c) => watched.push(c?.sender?.id ?? -1));
    const put = handlers.putHtml({ html: "<p>a</p>" }, ctx(WINDOW_A));
    expect(put.url).toBe(`nexus-preview://${put.token}/`);
    expect(documents.size(WINDOW_A)).toBe(1);
    expect(watched).toEqual([WINDOW_A]);
    expect(handlers.putHtml({ token: put.token, html: "<p>b</p>" }, ctx(WINDOW_A)).token).toBe(
      put.token,
    );
  });

  test("a pane that closes (its tab) lets go of its document", () => {
    const documents = new PreviewDocuments(tokens());
    const handlers = previewHandlers(documents);
    const { token } = handlers.putHtml({ html: "<p>a</p>" }, ctx(WINDOW_A));
    handlers.releaseHtml({ token }, ctx(WINDOW_B));
    expect(documents.get(token)).toBe("<p>a</p>");
    handlers.releaseHtml({ token }, ctx(WINDOW_A));
    expect(documents.get(token)).toBeUndefined();
  });
});

describe("cancelsAppSchemeRequest", () => {
  const preview = `nexus-preview://${"0".repeat(32)}/`;

  test("lets only an iframe load a preview document", () => {
    expect(cancelsPreviewRequest("subFrame")).toBe(false);
    expect(cancelsAppSchemeRequest("subFrame", preview)).toBe(false);
    for (const type of ["mainFrame", "script", "xhr", "image", "object", "other"]) {
      expect(cancelsAppSchemeRequest(type, preview)).toBe(true);
    }
  });

  test("keeps the workspace files' read guard", () => {
    expect(cancelsAppSchemeRequest("image", "nexus-workspace://ws-1/logo.png")).toBe(false);
    expect(cancelsAppSchemeRequest("subFrame", "nexus-workspace://ws-1/page.html")).toBe(false);
    expect(cancelsAppSchemeRequest("xhr", "nexus-workspace://ws-1/.env")).toBe(true);
  });

  test("guards the app's file:// requests in the same listener", () => {
    const renderer = path.resolve("/app/out/renderer");
    const own = pathToFileURL(path.join(renderer, "assets", "index.js")).href;
    const repo = pathToFileURL(path.resolve("/Users/u/repo/evil.js")).href;
    expect(cancelsAppRequest("script", own, renderer)).toBe(false);
    expect(cancelsAppRequest("script", repo, renderer)).toBe(true);
    expect(cancelsAppRequest("xhr", repo, renderer)).toBe(true);
    expect(cancelsAppRequest("image", repo, renderer)).toBe(false);
    expect(cancelsAppRequest("subFrame", preview, renderer)).toBe(false);
    expect(cancelsAppRequest("xhr", "nexus-workspace://ws-1/.env", renderer)).toBe(true);
  });
});
