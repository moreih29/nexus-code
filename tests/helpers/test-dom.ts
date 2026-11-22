import { createWindow } from "@mixmark-io/domino";
import { act } from "react";
import type { Root } from "react-dom/client";

/** Provides the DOM needed to exercise React effects and input events in Bun. */
export async function withTestDom(run: (host: HTMLElement, root: Root) => Promise<void>) {
  const page = createWindow('<div id="root"></div>');
  Object.defineProperty(page.document, "oninput", { value: null });
  const prototype = page.HTMLElement.prototype;
  Object.defineProperty(prototype, "scrollIntoView", { configurable: true, value: () => {} });
  Object.defineProperty(prototype, "setSelectionRange", {
    configurable: true,
    value(this: HTMLTextAreaElement, start: number, end: number) {
      this.selectionStart = start;
      this.selectionEnd = end;
    },
  });
  const globals = {
    document: page.document,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
  };
  const previous = Object.keys(globals).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  const previousWindow = globalThis.window;
  globalThis.window = page as unknown as Window & typeof globalThis;
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  try {
    const { createRoot } = await import("react-dom/client");
    const host = document.getElementById("root")!;
    const root = createRoot(host);
    try {
      await run(host, root);
    } finally {
      await act(async () => root.unmount());
    }
  } finally {
    globalThis.window = previousWindow;
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}
