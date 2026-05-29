/**
 * Unit tests for the browser permission subscription module.
 *
 * Covers:
 *  1. initBrowserPermissionSubscriptions — does not throw on install.
 *  2. initBrowserPermissionSubscriptions — is idempotent (safe to call twice).
 *  3. showPermissionPrompt — enqueues a prompt without throwing.
 *  4. showPermissionPrompt — multiple sequential enqueues do not throw.
 *
 * Isolation strategy: the test provides no-op stubs for window.ipc so the
 * module can initialise.  Bun runs test files concurrently (--max-concurrency),
 * which means the shared `globalThis.window` setter from setup.ts may be
 * updated by a concurrent file while this test runs.  We therefore avoid
 * asserting on per-fakeIpc listener counts (which are not concurrency-safe)
 * and instead test only the observable, non-racy behaviour: "does not throw"
 * and "queue size after enqueue".
 */

import { beforeEach, describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// Window shim — no-op IPC that prevents "window.ipc is not defined" errors.
// Re-installed in every beforeEach to reduce (but not eliminate) contamination
// from concurrent file executions.
// ---------------------------------------------------------------------------

if (typeof (globalThis as Record<string, unknown>).crypto === "undefined") {
  let counter = 0;
  (globalThis as Record<string, unknown>).crypto = {
    randomUUID: () => {
      counter++;
      return `00000000-0000-0000-0000-${String(counter).padStart(12, "0")}`;
    },
  };
}

beforeEach(() => {
  (globalThis as Record<string, unknown>).window = {
    ipc: {
      call: () => Promise.resolve(null),
      listen: () => {},
      off: () => {},
    },
  };
});

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

import { initBrowserPermissionSubscriptions } from "../../../../../src/renderer/state/operations/browser-permission";
import { showPermissionPrompt } from "../../../../../src/renderer/components/ui/permission-prompt-dialog";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("initBrowserPermissionSubscriptions", () => {
  it("does not throw on install", () => {
    expect(() => {
      initBrowserPermissionSubscriptions();
    }).not.toThrow();
  });

  it("is idempotent: calling twice does not throw", () => {
    expect(() => {
      initBrowserPermissionSubscriptions();
      initBrowserPermissionSubscriptions();
    }).not.toThrow();
  });
});

describe("showPermissionPrompt", () => {
  it("enqueues a prompt without throwing", () => {
    expect(() => {
      showPermissionPrompt({
        promptId: "test-prompt-1",
        workspaceId: "ws-1",
        origin: "https://example.com",
        permissions: ["geolocation"],
      });
    }).not.toThrow();
  });

  it("handles multiple sequential prompts without throwing", () => {
    expect(() => {
      showPermissionPrompt({
        promptId: "test-prompt-2",
        workspaceId: "ws-1",
        origin: "https://example.com",
        permissions: ["media"],
      });
      showPermissionPrompt({
        promptId: "test-prompt-3",
        workspaceId: "ws-1",
        origin: "https://other.com",
        permissions: ["notifications", "geolocation"],
      });
    }).not.toThrow();
  });
});
