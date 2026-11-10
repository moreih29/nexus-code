/**
 * Unit tests for browser operations — last-URL restoration.
 *
 * Tests cover:
 *  1. resolveInitialBrowserUrl — javascript: scheme → null.
 *  2. resolveInitialBrowserUrl — a rejected lastUrl does not fall back to initialUrl.
 */

import { describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// Minimal shims so Zustand runs in bun (no DOM needed)
// ---------------------------------------------------------------------------

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

// ---------------------------------------------------------------------------
// Imports (after shims)
// ---------------------------------------------------------------------------

import { resolveInitialBrowserUrl } from "../../../../../src/renderer/state/operations/browser";
import type { BrowserTabProps } from "../../../../../src/renderer/state/stores/tabs";

// ---------------------------------------------------------------------------
// resolveInitialBrowserUrl
// ---------------------------------------------------------------------------

describe("resolveInitialBrowserUrl", () => {
  function makeProps(lastUrl: string, initialUrl = "https://initial.example.com"): BrowserTabProps {
    return { initialUrl, lastUrl, partition: "persist:browser-ws" };
  }

  it("returns null for a javascript: scheme", () => {
    const result = resolveInitialBrowserUrl(makeProps("javascript:alert(1)"));
    expect(result).toBeNull();
  });

  it("does not fall back to initialUrl when lastUrl fails validation", () => {
    const result = resolveInitialBrowserUrl(
      makeProps("javascript:void(0)", "https://fallback.example.com"),
    );
    expect(result).toBeNull();
  });
});
