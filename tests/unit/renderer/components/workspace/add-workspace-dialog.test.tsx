/**
 * Tests for the Add Workspace dialog's pure SSH helpers (parseSshDestination,
 * parseSshPort).
 */

import { describe, expect, it } from "bun:test";
import {
  parseSshDestination,
  parseSshPort,
} from "../../../../../src/renderer/components/workspace/add-workspace/ssh-helpers";

// ---------------------------------------------------------------------------
// parseSshDestination — boundary coverage
// ---------------------------------------------------------------------------

describe("parseSshDestination", () => {
  it("parses bare hostname", () => {
    expect(parseSshDestination("example.com")).toEqual({ host: "example.com" });
  });

  it("parses user@host", () => {
    expect(parseSshDestination("ada@example.com")).toEqual({
      user: "ada",
      host: "example.com",
    });
  });

  it("trims leading/trailing whitespace", () => {
    expect(parseSshDestination("  ada@example.com  ")).toEqual({
      user: "ada",
      host: "example.com",
    });
  });

  it("returns null for empty string", () => {
    expect(parseSshDestination("")).toBeNull();
    expect(parseSshDestination("   ")).toBeNull();
  });

  it("returns null when host is missing after @", () => {
    expect(parseSshDestination("ada@")).toBeNull();
  });

  it("returns null when user is missing before @", () => {
    expect(parseSshDestination("@example.com")).toBeNull();
  });

  it("returns null when host contains whitespace", () => {
    expect(parseSshDestination("dev host")).toBeNull();
  });

  it("returns null for double-@ (a@b@c has @ in user part)", () => {
    expect(parseSshDestination("a@b@c")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseSshPort — boundary coverage
// ---------------------------------------------------------------------------

describe("parseSshPort", () => {
  it("returns undefined for empty string (use server default)", () => {
    expect(parseSshPort("")).toBeUndefined();
    expect(parseSshPort("   ")).toBeUndefined();
  });

  it("returns port number for valid ports", () => {
    expect(parseSshPort("22")).toBe(22);
    expect(parseSshPort("2222")).toBe(2222);
    expect(parseSshPort("65535")).toBe(65535);
    expect(parseSshPort("1")).toBe(1);
  });

  it("returns null for out-of-range port 0", () => {
    expect(parseSshPort("0")).toBeNull();
  });

  it("returns null for port above 65535", () => {
    expect(parseSshPort("65536")).toBeNull();
    expect(parseSshPort("70000")).toBeNull();
    expect(parseSshPort("99999")).toBeNull();
  });

  it("returns null for non-numeric input", () => {
    expect(parseSshPort("abc")).toBeNull();
    expect(parseSshPort("22abc")).toBeNull();
    expect(parseSshPort("22.5")).toBeNull();
  });

  it("returns null for negative numbers", () => {
    expect(parseSshPort("-1")).toBeNull();
  });

  it("reads leading zeros as decimal, not octal", () => {
    expect(parseSshPort("022")).toBe(22);
  });
});
