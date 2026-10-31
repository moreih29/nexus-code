/**
 * Tests for the Add Workspace dialog's pure SSH helpers (parseSshDestination,
 * parseSshPort, filterSshConfigHosts, findSshConfigHost).
 */

import { describe, expect, it } from "bun:test";
import {
  filterSshConfigHosts,
  findSshConfigHost,
  parseSshDestination,
  parseSshPort,
} from "../../../../../src/renderer/components/workspace/add-workspace/ssh-helpers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sshHosts = [
  {
    alias: "devbox",
    host: "dev.example.com",
    user: "ada",
    port: 2222,
    identityFile: "~/.ssh/devbox",
  },
  { alias: "staging", host: "staging.example.com" },
  { alias: "prod", host: "prod.example.com", user: "deploy" },
];

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

  it("parses IP address host", () => {
    expect(parseSshDestination("192.168.1.1")).toEqual({ host: "192.168.1.1" });
  });

  it("parses user@IP", () => {
    expect(parseSshDestination("root@192.168.1.1")).toEqual({
      user: "root",
      host: "192.168.1.1",
    });
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

// ---------------------------------------------------------------------------
// filterSshConfigHosts
// ---------------------------------------------------------------------------

describe("filterSshConfigHosts", () => {
  it("returns up to 8 hosts on empty query", () => {
    // With 3 hosts, all 3 returned
    const result = filterSshConfigHosts(sshHosts, "");
    expect(result).toHaveLength(3);
  });

  it("filters by alias prefix", () => {
    const result = filterSshConfigHosts(sshHosts, "dev");
    expect(result.map((h) => h.alias)).toEqual(["devbox"]);
  });

  it("filters by hostname substring", () => {
    const result = filterSshConfigHosts(sshHosts, "staging.example");
    expect(result.map((h) => h.alias)).toEqual(["staging"]);
  });

  it("filters by user", () => {
    const result = filterSshConfigHosts(sshHosts, "ada");
    expect(result.map((h) => h.alias)).toEqual(["devbox"]);
  });

  it("is case-insensitive", () => {
    const result = filterSshConfigHosts(sshHosts, "DEV");
    expect(result.map((h) => h.alias)).toEqual(["devbox"]);
  });

  it("returns empty array for no match", () => {
    expect(filterSshConfigHosts(sshHosts, "zzz")).toHaveLength(0);
  });

  it("caps at 8 results", () => {
    const manyHosts = Array.from({ length: 12 }, (_, i) => ({
      alias: `host-${i}`,
      host: `host-${i}.example.com`,
    }));
    expect(filterSshConfigHosts(manyHosts, "")).toHaveLength(8);
  });

  it("trims query before matching", () => {
    const result = filterSshConfigHosts(sshHosts, "  dev  ");
    expect(result.map((h) => h.alias)).toEqual(["devbox"]);
  });
});

// ---------------------------------------------------------------------------
// findSshConfigHost
// ---------------------------------------------------------------------------

describe("findSshConfigHost", () => {
  it("finds host by exact alias when selectedAlias is set", () => {
    const result = findSshConfigHost(sshHosts, "devbox", "devbox");
    expect(result?.alias).toBe("devbox");
  });

  it("finds host by hostInput when selectedAlias is null", () => {
    const result = findSshConfigHost(sshHosts, "staging", null);
    expect(result?.alias).toBe("staging");
  });

  it("returns null for empty hostInput", () => {
    expect(findSshConfigHost(sshHosts, "", null)).toBeNull();
  });

  it("returns null when hostInput contains @ (user@host direct entry)", () => {
    expect(findSshConfigHost(sshHosts, "ada@devbox", null)).toBeNull();
  });

  it("returns null when alias not found", () => {
    expect(findSshConfigHost(sshHosts, "unknown", null)).toBeNull();
  });

  it("selectedAlias takes precedence over hostInput", () => {
    const result = findSshConfigHost(sshHosts, "staging", "devbox");
    expect(result?.alias).toBe("devbox");
  });
});

// ---------------------------------------------------------------------------
// parseSshDestination edge cases — adversarial
// ---------------------------------------------------------------------------

describe("parseSshDestination adversarial", () => {
  it("handles single @ with no user or host", () => {
    expect(parseSshDestination("@")).toBeNull();
  });

  it("returns null for user with spaces (user name@host has whitespace in user part)", () => {
    expect(parseSshDestination("user name@host")).toBeNull();
  });

  it("handles hostname with tab character", () => {
    expect(parseSshDestination("host\t.com")).toBeNull();
  });

  it("handles very long valid host", () => {
    const longHost = `${"a".repeat(200)}.example.com`;
    const result = parseSshDestination(longHost);
    expect(result).toEqual({ host: longHost });
  });

  it("handles localhost", () => {
    expect(parseSshDestination("localhost")).toEqual({ host: "localhost" });
  });

  it("parses user@localhost", () => {
    expect(parseSshDestination("root@localhost")).toEqual({
      user: "root",
      host: "localhost",
    });
  });
});

// ---------------------------------------------------------------------------
// filterSshConfigHosts — N=0 edge
// ---------------------------------------------------------------------------

describe("filterSshConfigHosts edge cases", () => {
  it("handles empty host list", () => {
    expect(filterSshConfigHosts([], "any")).toHaveLength(0);
    expect(filterSshConfigHosts([], "")).toHaveLength(0);
  });

  it("matches host with undefined user (no user key)", () => {
    const hosts = [{ alias: "server", host: "server.example.com" }];
    // Should not throw when user is undefined
    expect(() => filterSshConfigHosts(hosts, "server")).not.toThrow();
    expect(filterSshConfigHosts(hosts, "server").map((h) => h.alias)).toEqual(["server"]);
  });
});
