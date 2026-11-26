import { describe, expect, test } from "bun:test";
import {
  FILE_GRANT_IDLE_MS,
  FILE_GRANT_MAX_MS,
  FileGrantTokenSchema,
  RpcErrorCode,
} from "../../../../../packages/remote-protocol/src";
import {
  FILE_GRANT_ISSUE_WINDOW_MS,
  FileGrants,
  type FileGrantWant,
  MAX_FILE_GRANT_ISSUES_PER_WINDOW,
  MAX_FILE_GRANTS_PER_DEVICE,
} from "../../../../../src/main/features/remote/file-grants";

function clock() {
  let at = 1_000_000;
  return {
    now: () => at,
    pass: (ms: number) => {
      at += ms;
    },
  };
}

function want(over: Partial<FileGrantWant> = {}): FileGrantWant {
  return {
    device: "qa-phone",
    epoch: "e1",
    workspaceId: "w",
    rootPath: "/qa/w",
    location: { kind: "local", rootPath: "/qa/w" },
    tabId: "t",
    path: "/qa/out/a.png",
    realPath: "/qa/out/a.png",
    source: { kind: "answer", itemKey: "i1" },
    ...over,
  };
}

const read = (w: FileGrantWant) => ({
  device: w.device,
  epoch: w.epoch,
  workspaceId: w.workspaceId,
  rootPath: w.rootPath,
  location: w.location,
  path: w.path,
});

describe("file grants on the host", () => {
  test("a token is 43 base64url characters and checks only against what it was given for", () => {
    const grants = new FileGrants();
    const asked = want();
    const { grant, expiresInMs, idleMs } = grants.issue(asked);
    expect(grant).toHaveLength(43);
    expect(FileGrantTokenSchema.safeParse(grant).success).toBe(true);
    expect([expiresInMs, idleMs]).toEqual([FILE_GRANT_MAX_MS, FILE_GRANT_IDLE_MS]);
    expect(grants.check(grant, read(asked)).realPath).toBe("/qa/out/a.png");
    for (const other of [
      { device: "qa-other" },
      { epoch: "e2" },
      { workspaceId: "w2" },
      { rootPath: "/qa/w2" },
      { location: { kind: "ssh", rootPath: "/qa/w" } },
      { path: "/qa/out/b.png" },
    ]) {
      expect(() => grants.check(grant, { ...read(asked), ...other })).toThrow(
        expect.objectContaining({ code: RpcErrorCode.Forbidden, data: { grant: "invalid" } }),
      );
    }
  });

  test("asking again for the same file from the same device and tab gives the same token", () => {
    const time = clock();
    const grants = new FileGrants(time);
    const first = grants.issue(want());
    time.pass(5 * 60_000);
    const again = grants.issue(want({ source: { kind: "tool", toolUseId: "u1" } }));
    expect(again.grant).toBe(first.grant);
    expect(again.expiresInMs).toBe(FILE_GRANT_MAX_MS - 5 * 60_000);
    expect(grants.issue(want({ tabId: "t2" })).grant).not.toBe(first.grant);
    expect(grants.issue(want({ device: "qa-other" })).grant).not.toBe(first.grant);
    expect(grants.issue(want({ epoch: "e2" })).grant).not.toBe(first.grant);
    expect(grants.size).toBe(4);
  });

  test("a token idles out after 10 minutes unused and ends 60 minutes after it was given", () => {
    const time = clock();
    const grants = new FileGrants(time);
    const asked = want();
    const { grant } = grants.issue(asked);
    for (let i = 0; i < 6; i += 1) {
      time.pass(9 * 60_000);
      grants.check(grant, read(asked));
      grants.touch(grant);
    }
    time.pass(6 * 60_000);
    expect(() => grants.check(grant, read(asked))).toThrow(
      expect.objectContaining({ code: RpcErrorCode.GrantExpired }),
    );
    const idle = grants.issue(want({ path: "/qa/out/b.png", realPath: "/qa/out/b.png" }));
    time.pass(FILE_GRANT_IDLE_MS);
    expect(() => grants.check(idle.grant, read(want({ path: "/qa/out/b.png" })))).toThrow(
      expect.objectContaining({ code: RpcErrorCode.GrantExpired }),
    );
    expect(() => grants.check("qa-unknown-token-0000000000", read(asked))).toThrow(
      expect.objectContaining({ code: RpcErrorCode.GrantExpired }),
    );
  });

  test("past 64 tokens a device's least recently used one is let go and answers as expired", () => {
    const time = clock();
    const grants = new FileGrants(time);
    const tokens: string[] = [];
    for (let i = 0; i < MAX_FILE_GRANTS_PER_DEVICE; i += 1) {
      if (i > 0 && i % MAX_FILE_GRANT_ISSUES_PER_WINDOW === 0)
        time.pass(FILE_GRANT_ISSUE_WINDOW_MS);
      time.pass(1);
      tokens.push(grants.issue(want({ path: `/qa/${i}`, realPath: `/qa/${i}` })).grant);
    }
    grants.touch(tokens[0] as string);
    time.pass(FILE_GRANT_ISSUE_WINDOW_MS);
    grants.issue(want({ path: "/qa/new", realPath: "/qa/new" }));
    expect(grants.size).toBe(MAX_FILE_GRANTS_PER_DEVICE);
    grants.check(tokens[0] as string, read(want({ path: "/qa/0" })));
    expect(() => grants.check(tokens[1] as string, read(want({ path: "/qa/1" })))).toThrow(
      expect.objectContaining({ code: RpcErrorCode.GrantExpired }),
    );
    grants.issue(want({ device: "qa-other" }));
    expect(grants.size).toBe(MAX_FILE_GRANTS_PER_DEVICE + 1);
  });

  test("only new tokens count toward 20 in 10 seconds", () => {
    const time = clock();
    const grants = new FileGrants(time);
    for (let i = 0; i < MAX_FILE_GRANT_ISSUES_PER_WINDOW; i += 1) {
      grants.issue(want({ path: `/qa/${i}`, realPath: `/qa/${i}` }));
    }
    grants.issue(want({ path: "/qa/0", realPath: "/qa/0" }));
    expect(() => grants.issue(want({ path: "/qa/more", realPath: "/qa/more" }))).toThrow(
      expect.objectContaining({ code: RpcErrorCode.Unavailable }),
    );
    grants.issue(want({ device: "qa-other" }));
    time.pass(FILE_GRANT_ISSUE_WINDOW_MS);
    grants.issue(want({ path: "/qa/more", realPath: "/qa/more" }));
  });

  test("a device leaving lets its tokens go as expired; a withdrawn source answers invalid", () => {
    const grants = new FileGrants();
    const mine = grants.issue(want());
    const other = grants.issue(want({ device: "qa-other" }));
    grants.dropDevice("qa-phone");
    expect(() => grants.check(mine.grant, read(want()))).toThrow(
      expect.objectContaining({ code: RpcErrorCode.GrantExpired }),
    );
    grants.check(other.grant, read(want({ device: "qa-other" })));
    grants.withdraw([other.grant]);
    expect(() => grants.check(other.grant, read(want({ device: "qa-other" })))).toThrow(
      expect.objectContaining({ code: RpcErrorCode.Forbidden, data: { grant: "invalid" } }),
    );
    grants.issue(want({ device: "qa-x" }));
    grants.dropDevice();
    expect(grants.size).toBe(0);
  });

  test("a file's tokens go with its parent's, and using a child keeps the parent alive", () => {
    const time = clock();
    const grants = new FileGrants(time);
    const parent = grants.issue(want({ path: "/qa/out/doc.md", realPath: "/qa/out/doc.md" }));
    const child = grants.issue(
      want({
        source: { kind: "file", parent: "/qa/out/doc.md", grant: parent.grant },
        parent: parent.grant,
      }),
    );
    time.pass(FILE_GRANT_IDLE_MS - 1);
    grants.touch(child.grant);
    time.pass(2);
    grants.check(parent.grant, read(want({ path: "/qa/out/doc.md" })));
    expect(grants.sourcesOf("w", "t").map((g) => g.token)).toEqual([parent.grant, child.grant]);
    grants.withdraw([parent.grant]);
    expect(() => grants.check(child.grant, read(want()))).toThrow(
      expect.objectContaining({ data: { grant: "invalid" } }),
    );
    const other = grants.issue(want({ tabId: "t2" }));
    grants.dropTab("w", "t2");
    expect(() => grants.check(other.grant, read(want()))).toThrow(
      expect.objectContaining({ data: { grant: "invalid" } }),
    );
  });
});
