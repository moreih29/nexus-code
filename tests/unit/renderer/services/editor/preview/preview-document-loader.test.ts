import { describe, expect, test } from "bun:test";
import {
  PreviewDocumentLoader,
  type PreviewDocumentStore,
  type PreviewFrame,
} from "../../../../../../src/renderer/services/editor/preview/preview-document-loader";

/** A store like main's, whose puts wait until `settle` is called. */
function fakeStore() {
  const documents = new Map<string, string>();
  const waiting: Array<() => void> = [];
  const puts: Array<{ html: string; token: string | undefined }> = [];
  const released: string[] = [];
  let next = 0;
  const store: PreviewDocumentStore = {
    put(html, token) {
      puts.push({ html, token });
      return new Promise((resolve) => {
        waiting.push(() => {
          const held = token !== undefined && documents.has(token) ? token : `t${next++}`;
          documents.set(held, html);
          resolve({ token: held, url: `nexus-preview://${held}/` });
        });
      });
    },
    release(token) {
      released.push(token);
      documents.delete(token);
    },
  };
  /** Lets the waiting puts finish, one after another. */
  const settle = async () => {
    while (waiting.length > 0) {
      waiting.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    }
  };
  return { store, documents, puts, released, settle };
}

function fakeFrame() {
  const calls: string[] = [];
  const frame: PreviewFrame = {
    setSrc: (url) => calls.push(`src ${url}`),
    replace: (url) => calls.push(`replace ${url}`),
  };
  return { frame, calls };
}

describe("PreviewDocumentLoader", () => {
  test("points the frame at the first document, and reloads it in place after", async () => {
    const { store, documents, settle } = fakeStore();
    const { frame, calls } = fakeFrame();
    const loader = new PreviewDocumentLoader(store, () => frame);
    void loader.load("<p>1</p>");
    await settle();
    void loader.load("<p>2</p>");
    await settle();
    expect(calls).toEqual(["src nexus-preview://t0/", "replace nexus-preview://t0/"]);
    expect(documents.get("t0")).toBe("<p>2</p>");
  });

  test("puts one document at a time, and collapses those behind it into the newest", async () => {
    const { store, puts, settle } = fakeStore();
    const { frame, calls } = fakeFrame();
    const loader = new PreviewDocumentLoader(store, () => frame);
    void loader.load("<p>1</p>");
    void loader.load("<p>2</p>");
    void loader.load("<p>3</p>");
    await settle();
    expect(puts).toEqual([
      { html: "<p>1</p>", token: undefined },
      { html: "<p>3</p>", token: "t0" },
    ]);
    expect(calls).toEqual(["src nexus-preview://t0/", "replace nexus-preview://t0/"]);
  });

  test("closing the pane (its tab) lets main go of its document", async () => {
    const { store, documents, released, settle } = fakeStore();
    const { frame } = fakeFrame();
    const loader = new PreviewDocumentLoader(store, () => frame);
    void loader.load("<p>1</p>");
    await settle();
    loader.close();
    expect(released).toEqual(["t0"]);
    expect(documents.size).toBe(0);
    void loader.load("<p>2</p>");
    await settle();
    expect(documents.size).toBe(0);
  });

  test("lets go of a document a put brings back after the pane closed", async () => {
    const { store, documents, released, settle } = fakeStore();
    const { frame, calls } = fakeFrame();
    const loader = new PreviewDocumentLoader(store, () => frame);
    void loader.load("<p>1</p>");
    loader.close();
    await settle();
    expect(released).toEqual(["t0"]);
    expect(documents.size).toBe(0);
    expect(calls).toEqual([]);
  });

  test("points the frame anew at a new token, as when main had let go of the old one", async () => {
    const { store, documents, settle } = fakeStore();
    const { frame, calls } = fakeFrame();
    const loader = new PreviewDocumentLoader(store, () => frame);
    void loader.load("<p>1</p>");
    await settle();
    documents.clear();
    void loader.load("<p>2</p>");
    await settle();
    expect(calls).toEqual(["src nexus-preview://t0/", "src nexus-preview://t1/"]);
  });

  test("tries the next document after a put that failed", async () => {
    const { frame, calls } = fakeFrame();
    let fail = true;
    const store: PreviewDocumentStore = {
      put: async () => {
        if (fail) return null;
        return { token: "t", url: "nexus-preview://t/" };
      },
      release: () => {},
    };
    const loader = new PreviewDocumentLoader(store, () => frame);
    await loader.load("<p>1</p>");
    expect(calls).toEqual([]);
    fail = false;
    await loader.load("<p>2</p>");
    expect(calls).toEqual(["src nexus-preview://t/"]);
  });
});
