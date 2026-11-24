import { afterEach, beforeEach, expect, test } from "bun:test";
import { ErrorBoundary } from "../../../../../src/renderer/components/ui/error-boundary";

const calls: unknown[][] = [];
const previous = (globalThis as Record<string, unknown>).window;

beforeEach(() => {
  calls.length = 0;
  (globalThis as Record<string, unknown>).window = {
    ipc: {
      call: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve(null);
      },
    },
  };
});

afterEach(() => {
  (globalThis as Record<string, unknown>).window = previous;
});

test("a render error is recorded by its boundary and name, never its message", () => {
  const boundary = new ErrorBoundary({ logSource: "workspace-panel:ws-1", children: null });
  boundary.componentDidCatch(
    new RangeError('Invalid content for node doc: <paragraph("secret")>'),
    {
      componentStack: "",
    },
  );
  expect(calls).toEqual([
    ["system", "recordError", { area: "render", code: "workspace-panel:range_error" }],
  ]);
});
