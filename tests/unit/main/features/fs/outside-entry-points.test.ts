import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

mock.module("electron", () => ({
  net: { fetch: mock(() => Promise.resolve(new Response(null, { status: 500 }))) },
  protocol: {
    registerSchemesAsPrivileged: mock(() => {}),
    handle: mock(() => {}),
  },
}));

const { buildNexusWorkspaceHandler } = await import(
  "../../../../../src/main/features/custom-protocols/nexus-workspace"
);
const { PreviewDocuments, previewHandlers } = await import(
  "../../../../../src/main/features/custom-protocols/nexus-preview"
);
const scopePaths = await import("../../../../../src/main/features/custom-protocols/preview-scopes");
const {
  grantOutsideHandler,
  outsideExistsHandler,
  readBinaryHandler,
  readExternalHandler,
  readRangeHandler,
} = await import("../../../../../src/main/features/fs/ipc/read-handlers");
const { cleanAbsolutePath, clearOutsideGrants, isOutsideGranted, resolveOutsideGrant } =
  await import("../../../../../src/main/features/fs/outside-grants");

const WS = "123e4567-e89b-12d3-a456-426614174000";
const WINDOWS = process.platform === "win32";

const PATH_KINDS: { path: string; kind: string; cleaned?: string }[] = JSON.parse(
  fs.readFileSync(
    path.join(import.meta.dir, "../../../../fixtures/windows-path-kinds.json"),
    "utf8",
  ),
);
const CLEANED_TO_SHARE = PATH_KINDS.filter(({ cleaned }) => cleaned !== undefined).map(
  ({ path }) => path,
);
const SHARE_OR_DEVICE = PATH_KINDS.filter(({ kind }) => kind === "unc" || kind === "device").map(
  ({ path }) => path,
);
const ROOTED = ["/tmp/a.txt", String.raw`\tmp\a.txt`, "/Users/u/a.png"];
const REFUSED = [...CLEANED_TO_SHARE, ...SHARE_OR_DEVICE, ...ROOTED].filter((p) => p !== "");

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-entry-")));
const granted = path.join(tmp, "granted.txt");
fs.writeFileSync(granted, "ok");
afterEach(() => clearOutsideGrants());
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function stubs() {
  const missing = async () => ({ kind: "missing", reason: "not-found" }) as const;
  const reads = {
    readAbsolute: mock(missing),
    readAbsoluteBinary: mock(missing),
    readAbsoluteRange: mock(missing),
    readBinary: mock(missing),
    readRange: mock(missing),
  };
  const provider = { kind: "local", ...reads };
  const getFs = mock(async () => provider);
  const meta = {
    id: WS,
    name: "w",
    pinned: false,
    tabs: [],
    rootPath: "C:/w",
    location: { kind: "local", rootPath: "C:/w" },
  };
  const manager = { getFs, list: () => [meta] } as never;
  return { manager, reads };
}

function outsideUrl(asked: string): string {
  return `nexus-workspace://${WS}.outside/${encodeURIComponent(asked.replace(/^\//, ""))}`;
}

describe("a path a POSIX clean would turn into a share", () => {
  test.if(WINDOWS)("is no outside path on Windows", () => {
    for (const asked of CLEANED_TO_SHARE) {
      expect([asked, cleanAbsolutePath(asked)]).toEqual([asked, null]);
    }
  });

  test.if(!WINDOWS)("is an ordinary POSIX path elsewhere", () => {
    for (const asked of CLEANED_TO_SHARE) {
      expect(cleanAbsolutePath(asked)).toBe(path.posix.normalize(asked));
    }
  });
});

describe.if(WINDOWS)(
  "every way the renderer names an outside path, in a local Windows workspace",
  () => {
    test("takes only drive paths, and resolves nothing else", async () => {
      const realpath = spyOn(fs.promises, "realpath");
      const realpathNative = spyOn(scopePaths, "realpathNative");
      const { manager, reads } = stubs();
      const scopes = new scopePaths.PreviewScopes("", undefined, () => "C:/w");
      const preview = previewHandlers(new PreviewDocuments(), () => {}, scopes);
      const protocol = buildNexusWorkspaceHandler(manager, undefined, scopes);
      try {
        await grantOutsideHandler(manager)({
          workspaceId: WS,
          owner: "tab",
          files: REFUSED,
          dirs: REFUSED,
        });
        for (const asked of REFUSED) {
          expect([asked, isOutsideGranted(WS, asked)]).toEqual([asked, false]);
          expect([asked, await resolveOutsideGrant(WS, asked)]).toEqual([asked, null]);
          expect(
            await readBinaryHandler(manager)({ workspaceId: WS, relPath: asked }),
          ).toMatchObject({ kind: "missing" });
          expect(
            await readRangeHandler(manager)({
              workspaceId: WS,
              relPath: asked,
              offset: 0,
              length: 1,
            }),
          ).toMatchObject({ kind: "missing" });
          expect((await protocol(new Request(outsideUrl(asked)))).status).toBe(404);
          expect(await preview.openScope({ workspaceId: WS, dir: asked })).toBeNull();
          expect(
            await outsideExistsHandler(manager)({ workspaceId: WS, absolutePath: asked }),
          ).toBe(false);
          expect(
            await readExternalHandler(manager)({ workspaceId: WS, absolutePath: asked }),
          ).toMatchObject({ kind: "missing" });
        }
        expect(realpath).not.toHaveBeenCalled();
        expect(realpathNative).not.toHaveBeenCalled();
        expect(reads.readAbsolute).not.toHaveBeenCalled();
        expect(reads.readAbsoluteBinary).not.toHaveBeenCalled();
        expect(reads.readAbsoluteRange).not.toHaveBeenCalled();

        await grantOutsideHandler(manager)({
          workspaceId: WS,
          owner: "tab",
          files: [granted],
          dirs: [],
        });
        expect(await resolveOutsideGrant(WS, granted)).toBe(granted);
        expect(realpath).toHaveBeenCalled();
        expect(await preview.openScope({ workspaceId: WS, dir: tmp })).not.toBeNull();
        expect(realpathNative).toHaveBeenCalled();
      } finally {
        realpath.mockRestore();
        realpathNative.mockRestore();
      }
    });
  },
);

describe.if(!WINDOWS)("a local outside file a chat links", () => {
  test("is not looked at when a link on the way leads to an automount path", async () => {
    const linked = path.join(tmp, "share");
    fs.symlinkSync(tmp, linked);
    const readlink = spyOn(fs.promises, "readlink").mockImplementation((async (p: string) =>
      p === linked ? "/net/qa-s3" : "") as never);
    const { manager, reads } = stubs();
    reads.readAbsoluteRange.mockImplementation((async () => ({
      kind: "ok",
      base64: "",
      sizeBytes: 0,
      mtime: "",
    })) as never);
    try {
      expect(
        await outsideExistsHandler(manager)({
          workspaceId: WS,
          absolutePath: path.join(linked, "granted.txt"),
        }),
      ).toBe(false);
      expect(reads.readAbsoluteRange).not.toHaveBeenCalled();
      readlink.mockRestore();
      expect(
        await outsideExistsHandler(manager)({
          workspaceId: WS,
          absolutePath: path.join(linked, "granted.txt"),
        }),
      ).toBe(true);
      expect(reads.readAbsoluteRange).toHaveBeenCalledTimes(1);
    } finally {
      readlink.mockRestore();
      fs.rmSync(linked);
    }
  });
});
