// Tests for src/utility/pty-host/index.ts entry-point message routing.
// Specifically guards the event.ports[0] access pattern — the bug that caused
// the infinite restart loop when event.data.port was used instead.
//
// The module under test reads process.parentPort synchronously at load time, so
// we must (a) install the fake BEFORE the module is evaluated, and (b) use a
// dynamic import() so Bun's static-import hoisting does not run the module
// before our setup code.

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// Fake collaborators — installed before the module loads
// ---------------------------------------------------------------------------

const attachPortCalls: unknown[] = [];

class FakePtyManager {
  attachPort(port: unknown): void {
    attachPortCalls.push(port);
  }
  killAll(): void {}
}

mock.module("../../src/utility/pty-host/ptyManager", () => ({
  PtyManager: FakePtyManager,
}));

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

// Top-level await is supported in Bun test files.
await import("../../src/utility/pty-host/index");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pty-host entry — port handshake via event.ports[0]", () => {
  beforeEach(() => {
    attachPortCalls.length = 0;
  });

  test("delivers port from event.ports[0] to PtyManager.attachPort", () => {
    const fakePort = { on: () => {}, start: () => {}, postMessage: () => {} };

    fakeParentPort.deliver({ type: "port" }, [fakePort]);

    expect(attachPortCalls.length).toBe(1);
    expect(attachPortCalls[0]).toBe(fakePort);
  });

  test("does NOT crash and does NOT call attachPort when event.ports is empty", () => {
    // Guard: missing ports must not throw — fail-fast log, no crash.
    expect(() => {
      fakeParentPort.deliver({ type: "port" }, []);
    }).not.toThrow();

    expect(attachPortCalls.length).toBe(0);
  });

  test("ignores messages with unknown type — no attachPort call", () => {
    const fakePort = { on: () => {}, start: () => {}, postMessage: () => {} };

    fakeParentPort.deliver({ type: "unknown-msg" }, [fakePort]);

    expect(attachPortCalls.length).toBe(0);
  });

  test("second 'port' message delivers second port independently", () => {
    const port1 = { id: 1 };
    const port2 = { id: 2 };

    fakeParentPort.deliver({ type: "port" }, [port1]);
    fakeParentPort.deliver({ type: "port" }, [port2]);

    expect(attachPortCalls.length).toBe(2);
    expect(attachPortCalls[0]).toBe(port1);
    expect(attachPortCalls[1]).toBe(port2);
  });

  test("event.data.port being present does NOT reach attachPort (regression guard)", () => {
    // If someone reverts to event.data.port, this test catches it.
    // data has a port field, but event.ports is empty — attachPort must NOT be called.
    const dataPort = { on: () => {}, start: () => {}, postMessage: () => {} };

    fakeParentPort.deliver({ type: "port", port: dataPort }, []);

    expect(attachPortCalls.length).toBe(0);
  });
});
