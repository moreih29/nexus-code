import { describe, expect, test } from "bun:test";
import {
  FileResolvedSchema,
  RpcErrorCode,
  type RpcParams,
  type RpcResult,
} from "../../../../../packages/remote-protocol/src";
import {
  grantFailure,
  type PeerFileGrantCalls,
  PeerFileGrants,
} from "../../../../../src/main/features/remote/peer-file-grants";
import { RpcFailure } from "../../../../../src/main/features/remote/room";
import type { RoomState } from "../../../../../src/shared/remote/room";

const PEER = { deviceId: "device", workspaceId: "ws" };
const TOKEN = "a".repeat(43);
const NEXT = "b".repeat(43);
const PARENT = "c".repeat(43);

function room(serves = ["chat.read", "files", "files.grants"], rejoins = 0): RoomState {
  return {
    status: "online",
    peers: [
      {
        id: PEER.deviceId,
        name: "peer",
        platform: "linux",
        online: true,
        schema: "0.40.0",
        rejoins,
        serves,
      },
    ],
  };
}

function fixture(
  grant: (params: RpcParams<"files.grant">) => RpcResult<"files.grant">,
  resolve: (params: RpcParams<"files.resolve">) => RpcResult<"files.resolve"> = (params) => ({
    found: params.links.map(() => null),
  }),
) {
  const granted: RpcParams<"files.grant">[] = [];
  const resolved: RpcParams<"files.resolve">[] = [];
  let now = 1_000;
  const calls: PeerFileGrantCalls = {
    grant: async (_device, params) => {
      granted.push(params);
      return grant(params);
    },
    resolve: async (_device, params) => {
      resolved.push(params);
      return resolve(params);
    },
  };
  const grants = new PeerFileGrants(calls, () => now);
  grants.updateRoom(room());
  return {
    grants,
    granted,
    resolved,
    later: (ms: number) => {
      now += ms;
    },
  };
}

const answer = { kind: "answer", itemKey: "a-1" } as const;

describe("file grants this desktop holds for another device", () => {
  test("a click keeps the token in main and the renderer only learns the path", async () => {
    const { grants, granted } = fixture(() => ({
      path: "/outside/qa-a.txt",
      grant: TOKEN,
      expiresInMs: 3_600_000,
      idleMs: 600_000,
    }));
    const result = await grants.grant(PEER, "t1", { href: "../qa-a.txt", source: answer }, "open");
    expect(result).toEqual({ path: "/outside/qa-a.txt" });
    expect(granted).toEqual([
      { workspaceId: "ws", tabId: "t1", href: "../qa-a.txt", source: answer, purpose: "open" },
    ]);
    expect(grants.token(PEER, "/outside/qa-a.txt")).toBe(TOKEN);
    expect(grants.token({ ...PEER, workspaceId: "other" }, "/outside/qa-a.txt")).toBeUndefined();
  });

  test("a path read with no grant is remembered without a token so it can ask again", async () => {
    const { grants } = fixture(() => ({ path: "/outside/qa-done.png" }));
    await grants.grant(PEER, "t1", { href: "/outside/qa-done.png", source: answer }, "open");
    expect(grants.holds(PEER, "/outside/qa-done.png")).toBe(true);
    expect(grants.token(PEER, "/outside/qa-done.png")).toBeUndefined();
  });

  test("renewing asks again with the same tab, link, source and purpose", async () => {
    let token = TOKEN;
    const { grants, granted } = fixture(() => ({ path: "/o/qa.txt", grant: token }));
    await grants.grant(PEER, "t1", { href: "/o/qa.txt", source: answer }, "share");
    token = NEXT;
    expect(await grants.renew(PEER, "/o/qa.txt")).toBe(true);
    expect(granted[1]).toEqual(granted[0]);
    expect(grants.token(PEER, "/o/qa.txt")).toBe(NEXT);
    expect(await grants.renew(PEER, "/o/never-clicked.txt")).toBe(false);
    expect(granted).toHaveLength(2);
  });

  test("renewing forgets the path when its source is gone", async () => {
    let gone = false;
    const { grants } = fixture(() => {
      if (gone) throw new RpcFailure(RpcErrorCode.NotFound, "that link is not in that part");
      return { path: "/o/qa.txt", grant: TOKEN };
    });
    await grants.grant(PEER, "t1", { href: "/o/qa.txt", source: answer }, "open");
    gone = true;
    await expect(grants.renew(PEER, "/o/qa.txt")).rejects.toThrow("not in that part");
    expect(grants.holds(PEER, "/o/qa.txt")).toBe(false);
  });

  test("a token past its lifetime is stale", async () => {
    const { grants, later } = fixture(() => ({
      path: "/o/qa.txt",
      grant: TOKEN,
      expiresInMs: 60_000,
    }));
    await grants.grant(PEER, "t1", { href: "/o/qa.txt", source: answer }, "open");
    expect(grants.stale(PEER, "/o/qa.txt")).toBe(false);
    later(60_000);
    expect(grants.stale(PEER, "/o/qa.txt")).toBe(true);
  });

  test("a link in an opened file carries its parent's token, and an expired parent is renewed up the chain", async () => {
    let parentToken = PARENT;
    let expired = true;
    const { grants, granted } = fixture((params) => {
      if (params.source.kind !== "file") return { path: "/o/parent.md", grant: parentToken };
      if (expired && params.source.grant === PARENT) {
        throw new RpcFailure(RpcErrorCode.GrantExpired, "grant expired");
      }
      return { path: "/o/child.png", grant: TOKEN };
    });
    await grants.grant(PEER, "t1", { href: "/o/parent.md", source: answer }, "open");
    parentToken = NEXT;
    const child = { kind: "file", parent: "/o/parent.md" } as const;
    expect(await grants.grant(PEER, "t1", { href: "child.png", source: child }, "open")).toEqual({
      path: "/o/child.png",
    });
    expect(granted.map((p) => p.source)).toEqual([
      answer,
      { kind: "file", parent: "/o/parent.md", grant: PARENT },
      answer,
      { kind: "file", parent: "/o/parent.md", grant: NEXT },
    ]);
    expired = false;
    expect(grants.token(PEER, "/o/parent.md")).toBe(NEXT);
  });

  test("a parent read with no grant sends no token", async () => {
    const { grants, granted } = fixture((params) =>
      params.source.kind === "file" ? { path: "/w/x.png" } : { path: "/w/a.md" },
    );
    await grants.grant(PEER, "t1", { href: "/w/a.md", source: answer }, "open");
    await grants.grant(
      PEER,
      "t1",
      { href: "x.png", source: { kind: "file", parent: "/w/a.md", grant: TOKEN } },
      "open",
    );
    expect(granted[1]?.source).toEqual({ kind: "file", parent: "/w/a.md" });
  });

  test("links are resolved 64 at a time, in order", async () => {
    const { grants, resolved } = fixture(
      () => ({ path: "/x" }),
      (params) => ({
        found: params.links.map(({ href }) =>
          FileResolvedSchema.parse({ path: `/o/${href}`, readable: href.endsWith("0") }),
        ),
      }),
    );
    const links = Array.from({ length: 70 }, (_, i) => ({ href: `qa-${i}`, source: answer }));
    const found = await grants.resolve(PEER, "t1", links);
    expect(resolved.map((p) => p.links.length)).toEqual([64, 6]);
    expect(found).toHaveLength(70);
    expect(found[69]).toEqual({ path: "/o/qa-69", readable: false });
    expect(found[10]).toEqual({ path: "/o/qa-10", readable: true });
    expect(resolved[0]).toMatchObject({ workspaceId: "ws", tabId: "t1" });
  });

  test("resolving in an opened file renews an expired parent once", async () => {
    let fresh = false;
    const { grants, resolved } = fixture(
      () => ({ path: "/o/parent.md", grant: fresh ? NEXT : PARENT }),
      (params) => {
        const source = params.links[0]?.source;
        if (source?.kind === "file" && source.grant === PARENT) {
          throw new RpcFailure(RpcErrorCode.GrantExpired, "grant expired");
        }
        return { found: [{ blocked: true }] };
      },
    );
    await grants.grant(PEER, "t1", { href: "/o/parent.md", source: answer }, "open");
    fresh = true;
    const found = await grants.resolve(PEER, "t1", [
      { href: "//host/share/x.png", source: { kind: "file", parent: "/o/parent.md" } },
    ]);
    expect(found).toEqual([{ blocked: true }]);
    expect(resolved).toHaveLength(2);
  });

  test("a rejoin, a lost capability or leaving the room drops every grant", async () => {
    for (const next of [
      room(undefined, 1),
      room(["chat.read", "files"]),
      { ...room(), peers: [] },
    ]) {
      const { grants } = fixture(() => ({ path: "/o/qa.txt", grant: TOKEN }));
      await grants.grant(PEER, "t1", { href: "/o/qa.txt", source: answer }, "open");
      grants.updateRoom(next);
      expect(grants.token(PEER, "/o/qa.txt")).toBeUndefined();
    }
  });

  test("a device that does not serve file grants is not asked", async () => {
    const { grants, granted } = fixture(() => ({ path: "/x" }));
    grants.updateRoom(room(["chat.read", "files"]));
    await expect(
      grants.grant(PEER, "t1", { href: "/x", source: answer }, "open"),
    ).rejects.toMatchObject({ code: RpcErrorCode.MethodNotFound });
    expect(granted).toEqual([]);
  });

  test("grant failures are read from the error code and data", () => {
    expect(grantFailure(new RpcFailure(RpcErrorCode.GrantExpired, "x"))).toBe("expired");
    expect(grantFailure(new RpcFailure(RpcErrorCode.Forbidden, "x", { grant: "required" }))).toBe(
      "required",
    );
    expect(grantFailure(new RpcFailure(RpcErrorCode.Forbidden, "x", { grant: "invalid" }))).toBe(
      "invalid",
    );
    expect(
      grantFailure(new RpcFailure(RpcErrorCode.Forbidden, "x", { grant: "later" })),
    ).toBeNull();
    expect(grantFailure(new RpcFailure(RpcErrorCode.Forbidden, "x"))).toBeNull();
    expect(grantFailure(new Error("x"))).toBeNull();
  });
});
