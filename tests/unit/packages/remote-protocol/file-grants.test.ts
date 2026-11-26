import { describe, expect, test } from "bun:test";
import { z } from "zod";
import pkg from "../../../../packages/remote-protocol/package.json";
import {
  CAPABILITIES,
  FILE_GRANT_IDLE_MS,
  FILE_GRANT_MAX_MS,
  FILE_GRANTS_SCHEMA,
  FileAccessErrorDataSchema,
  FileGrantTokenSchema,
  FileLinkSourceSchema,
  FileResolvedSchema,
  MAX_FILE_RESOLVE_LINKS,
  MAX_FILE_SOURCE_PARENT_BYTES,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  RELAY_VERSION,
  RemoteConsentSchema,
  RPC_METHODS,
  RpcErrorCode,
  SCHEMA_VERSION,
} from "../../../../packages/remote-protocol/src";

const token = "a".repeat(43);
const from = { kind: "tab" as const, workspaceId: "w", tabId: "t" };

const sources = [
  { kind: "answer", itemKey: "i1" },
  { kind: "received", itemKey: "i2", runId: "r1" },
  { kind: "taskEnd", itemKey: "i3" },
  { kind: "streaming", messageId: "m1" },
  { kind: "tool", toolUseId: "tu1", runId: "r2" },
  { kind: "user", itemKey: "i4" },
  { kind: "job", taskId: "j1" },
  { kind: "change" },
  { kind: "change", runId: "r3" },
  { kind: "file", parent: "/Users/me/notes.md" },
  { kind: "file", parent: "/Users/me/notes.md", grant: token },
] as const;

describe("remote file grants (0.40.0)", () => {
  test("the package is 0.40.0 and the wire versions stay", () => {
    expect(SCHEMA_VERSION).toBe("0.40.0");
    expect(pkg.version).toBe("0.40.0");
    expect(FILE_GRANTS_SCHEMA).toBe("0.40.0");
    expect(PROTOCOL_VERSION).toBe(2);
    expect(RELAY_VERSION).toBe(2);
    expect(MAX_FRAME_BYTES).toBe(1024 * 1024);
  });

  test("files.grants is a capability, and both new methods take it", () => {
    expect(CAPABILITIES).toContain("files.grants");
    expect(RPC_METHODS["files.resolve"].capability).toBe("files.grants");
    expect(RPC_METHODS["files.grant"].capability).toBe("files.grants");
  });

  test("limits and the expired grant's error code", () => {
    expect(RpcErrorCode.GrantExpired).toBe(1004);
    expect(MAX_FILE_RESOLVE_LINKS).toBe(64);
    expect(FILE_GRANT_IDLE_MS).toBe(10 * 60_000);
    expect(FILE_GRANT_MAX_MS).toBe(60 * 60_000);
    expect(MAX_FILE_SOURCE_PARENT_BYTES).toBe(5 * 1024 * 1024);
  });

  test("every source kind goes there and back, with its runId", () => {
    for (const source of sources) {
      expect(FileLinkSourceSchema.parse(source)).toEqual(source);
    }
  });

  test("a source of an unknown kind or without its key is refused", () => {
    expect(FileLinkSourceSchema.safeParse({ kind: "opened" }).success).toBe(false);
    expect(FileLinkSourceSchema.safeParse({ kind: "answer" }).success).toBe(false);
    expect(FileLinkSourceSchema.safeParse({ kind: "answer", itemKey: "" }).success).toBe(false);
    expect(FileLinkSourceSchema.safeParse({ kind: "file", parent: "" }).success).toBe(false);
    expect(
      FileLinkSourceSchema.safeParse({ kind: "file", parent: "/a.md", grant: "short" }).success,
    ).toBe(false);
  });

  test("a grant token is 22 to 64 base64url characters", () => {
    expect(FileGrantTokenSchema.safeParse("A".repeat(22)).success).toBe(true);
    expect(FileGrantTokenSchema.safeParse(`${"_-".repeat(32)}`).success).toBe(true);
    expect(FileGrantTokenSchema.safeParse("A".repeat(21)).success).toBe(false);
    expect(FileGrantTokenSchema.safeParse("A".repeat(65)).success).toBe(false);
    expect(FileGrantTokenSchema.safeParse(`${"A".repeat(42)}=`).success).toBe(false);
    expect(FileGrantTokenSchema.safeParse(`${"A".repeat(42)}+`).success).toBe(false);
  });

  test("files.resolve takes 1 to 64 links of href and source", () => {
    const { params } = RPC_METHODS["files.resolve"];
    const link = { href: "notes.txt", source: sources[0] };
    const ask = (n: number) => ({ workspaceId: "w", tabId: "t", links: Array(n).fill(link) });
    expect(params.safeParse(ask(1)).success).toBe(true);
    expect(params.safeParse(ask(MAX_FILE_RESOLVE_LINKS)).success).toBe(true);
    expect(params.safeParse(ask(0)).success).toBe(false);
    expect(params.safeParse(ask(MAX_FILE_RESOLVE_LINKS + 1)).success).toBe(false);
    expect(
      params.safeParse({ workspaceId: "w", tabId: "t", links: [{ ...link, href: "" }] }).success,
    ).toBe(false);
    expect(params.parse({ ...ask(1), from }).from).toEqual(from);
  });

  test("files.resolve answers a path, blocked or null for each link", () => {
    const { result } = RPC_METHODS["files.resolve"];
    const found = [
      { path: "/Users/me/a.png", readable: true },
      { path: "/Users/me/b.txt", readable: false },
      { blocked: true },
      null,
    ];
    expect(result.parse({ found })).toEqual({ found });
  });

  test("an entry of files.resolve a reader cannot read becomes null, not the whole answer", () => {
    const { result } = RPC_METHODS["files.resolve"];
    expect(
      result.parse({
        found: [{ path: "/a" }, { blocked: false }, { kind: "later" }, { path: "/b", readable: 1 }],
      }),
    ).toEqual({ found: [null, null, null, null] });
    expect(FileResolvedSchema.parse({ path: "/c", readable: true })).toEqual({
      path: "/c",
      readable: true,
    });
  });

  test("files.grant takes href, source and purpose, and answers a path with an optional token", () => {
    const { params, result } = RPC_METHODS["files.grant"];
    const ask = {
      workspaceId: "w",
      tabId: "t",
      href: "../out/report.txt",
      source: sources[4],
      purpose: "open",
    };
    expect(params.parse(ask)).toEqual(ask);
    for (const purpose of ["open", "original", "share"]) {
      expect(params.safeParse({ ...ask, purpose }).success).toBe(true);
    }
    expect(params.safeParse({ ...ask, purpose: "copy" }).success).toBe(false);
    expect(params.safeParse({ ...ask, href: "" }).success).toBe(false);
    expect(params.parse({ ...ask, from }).from).toEqual(from);
    expect(result.parse({ path: "/inside/a.ts" })).toEqual({ path: "/inside/a.ts" });
    const granted = { path: "/out/a.txt", grant: token, expiresInMs: 3_600_000, idleMs: 600_000 };
    expect(result.parse(granted)).toEqual(granted);
    expect(result.safeParse({ ...granted, grant: "bad token" }).success).toBe(false);
  });

  test("files.read carries a grant; an older host's schema drops it", () => {
    const { params } = RPC_METHODS["files.read"];
    const read = { workspaceId: "w", path: "/out/a.txt", as: "bytes" as const, grant: token };
    expect(params.parse(read).grant).toBe(token);
    expect(params.safeParse({ ...read, grant: "x" }).success).toBe(false);
    const { grant: _, ...olderShape } = params.shape;
    expect(z.object(olderShape).parse(read)).toEqual({
      workspaceId: "w",
      path: "/out/a.txt",
      as: "bytes",
    });
  });

  test("a file access error's data says invalid, required or beyond; unknown values drop alone", () => {
    expect(FileAccessErrorDataSchema.parse({ grant: "required" })).toEqual({ grant: "required" });
    expect(FileAccessErrorDataSchema.parse({ grant: "invalid" })).toEqual({ grant: "invalid" });
    expect(FileAccessErrorDataSchema.parse({ reason: "beyond" })).toEqual({ reason: "beyond" });
    expect(FileAccessErrorDataSchema.parse({ grant: "later", reason: "later" })).toEqual({});
  });

  test("a consent prompt tells a network path; an unknown kind or an older reader leave it out", () => {
    const consent = {
      id: "c1",
      at: 1000,
      expiresAt: 91_000,
      expiresInMs: 85_000,
      from: { workspaceId: "w9", tabId: "t9" },
      workspaceId: "w1",
      change: { kind: "fileRead", detail: "//host/share/a.txt" },
      eachTime: true,
      answerable: true,
    };
    const network = { ...consent, change: { ...consent.change, pathKind: "network" } };
    expect(RemoteConsentSchema.parse(network)).toEqual(network);
    expect(RemoteConsentSchema.parse(consent).change.pathKind).toBeUndefined();
    const later = RemoteConsentSchema.parse({
      ...consent,
      change: { ...consent.change, pathKind: "device" },
    });
    expect(later).toEqual(consent);
    const { pathKind: _, ...olderChange } = RemoteConsentSchema.shape.change.shape;
    const older = RemoteConsentSchema.extend({ change: z.object(olderChange) });
    expect(older.parse(network)).toEqual(consent);
  });
});
