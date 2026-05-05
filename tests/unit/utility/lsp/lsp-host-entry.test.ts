// Tests for src/utility/lsp-host/index.ts entry-point message routing.
// Specifically guards the event.ports[0] access pattern — the same bug that
// caused the infinite restart loop when event.data.port was used instead.
//
// The module under test reads process.parentPort synchronously at load time, so
// we must (a) install the fake parentPort BEFORE the module is evaluated, and
// (b) use a dynamic import() so Bun's static-import hoisting does not run the
// module before our setup code.
//
// We use spyOn against LspManager.prototype.attachPort instead of mocking the
// whole lsp-manager module — module mocks leak across files in bun:test, and
// lsp-manager.test.ts needs to instantiate the real class.

import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { LspManager } from "../../../../src/utility/lsp-host/lsp-manager";

// ---------------------------------------------------------------------------
// Spy on LspManager.attachPort — captures the port without running real LSP
// servers. attachPort itself only sets up the message listener; the
// TypeScriptServer is not spawned until a didOpen arrives.
// ---------------------------------------------------------------------------

const attachPortSpy = spyOn(LspManager.prototype, "attachPort").mockImplementation(() => {});

// ---------------------------------------------------------------------------
// Fake parentPort — must be in place before the module is evaluated
// ---------------------------------------------------------------------------

type MessageHandler = (e: { data: unknown; ports: unknown[] }) => void;

class FakeParentPort {
  private handlers: MessageHandler[] = [];

  on(_event: "message", handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  postMessage(_data: unknown): void {}

  deliver(data: unknown, ports: unknown[] = []): void {
    for (const h of this.handlers) {
      h({ data, ports });
    }
  }
}

const fakeParentPort = new FakeParentPort();
(process as unknown as Record<string, unknown>).parentPort = fakeParentPort;

// ---------------------------------------------------------------------------
// Load the entry point via dynamic import so it evaluates AFTER the setup above
// ---------------------------------------------------------------------------

await import("../../../../src/utility/lsp-host/index");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("lsp-host entry — port handshake via event.ports[0]", () => {
  beforeEach(() => {
    attachPortSpy.mockClear();
  });

  afterAll(() => {
    // Restore prototype so other test files (lsp-manager.test.ts) get the
    // real attachPort. spyOn pollutes the prototype across files in bun:test.
    attachPortSpy.mockRestore();
  });

  test("delivers port from event.ports[0] to LspManager.attachPort", () => {
    const fakePort = { on: () => {}, start: () => {}, postMessage: () => {} };

    fakeParentPort.deliver({ type: "port" }, [fakePort]);

    expect(attachPortSpy).toHaveBeenCalledTimes(1);
    expect(attachPortSpy.mock.calls[0][0]).toBe(fakePort);
  });

  test("does NOT crash and does NOT call attachPort when event.ports is empty", () => {
    expect(() => {
      fakeParentPort.deliver({ type: "port" }, []);
    }).not.toThrow();

    expect(attachPortSpy).not.toHaveBeenCalled();
  });

  test("second 'port' message delivers second port independently", () => {
    const port1 = { id: 1 };
    const port2 = { id: 2 };

    fakeParentPort.deliver({ type: "port" }, [port1]);
    fakeParentPort.deliver({ type: "port" }, [port2]);

    expect(attachPortSpy).toHaveBeenCalledTimes(2);
    expect(attachPortSpy.mock.calls[0][0]).toBe(port1);
    expect(attachPortSpy.mock.calls[1][0]).toBe(port2);
  });

  test("event.data.port being present does NOT reach attachPort (regression guard)", () => {
    const dataPort = { on: () => {}, start: () => {}, postMessage: () => {} };

    fakeParentPort.deliver({ type: "port", port: dataPort }, []);

    expect(attachPortSpy).not.toHaveBeenCalled();
  });
});
