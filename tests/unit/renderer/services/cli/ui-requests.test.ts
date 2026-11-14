/** The renderer's side of the nexus CLI: one listener, so each request is carried out once. */
import { afterAll, expect, test } from "bun:test";

type Listener = (args: unknown) => void;
/** The cli:uiRequest listeners; other modules listen to other events on import. */
const listeners = new Set<Listener>();
const calls: unknown[][] = [];

const globals = globalThis as { window?: unknown; document?: unknown };
const originalWindow = globals.window;
const originalDocument = globals.document;
// A request notes what holds the keyboard, to give it back after.
globals.document ??= { activeElement: null, body: null, hasFocus: () => false };
globals.window = {
  ...(originalWindow as object),
  ipc: {
    call: (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve(null);
    },
    listen: (channel: string, event: string, callback: Listener) => {
      if (channel !== "cli" || event !== "uiRequest") return () => {};
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    off: () => {},
  },
};

afterAll(() => {
  globals.window = originalWindow;
  globals.document = originalDocument;
});

const { markCliUiReady, startCliUiListener } = await import(
  "../../../../../src/renderer/services/cli/ui-requests"
);

test("a request is carried out once, however often the app boots", async () => {
  startCliUiListener();
  startCliUiListener();
  const stop = startCliUiListener();
  expect(listeners.size).toBe(1);

  markCliUiReady();
  for (const listener of listeners) listener({ requestId: "r1", op: "no.such.op", args: {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const answers = calls.filter(([channel, method]) => channel === "cli" && method === "uiRespond");
  expect(answers).toHaveLength(1);
  expect(answers[0]?.[2]).toMatchObject({ requestId: "r1", ok: false });

  stop();
  expect(listeners.size).toBe(0);
  // A stop from before leaves the listener installed after it.
  const older = startCliUiListener();
  startCliUiListener();
  older();
  expect(listeners.size).toBe(1);
});
