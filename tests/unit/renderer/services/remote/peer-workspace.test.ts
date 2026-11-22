import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MAX_BYTES_CHUNK,
  MAX_READ_BYTES,
  RpcErrorCode,
} from "../../../../../packages/remote-protocol/src/rpc";
import { PeerFileReads } from "../../../../../src/main/features/remote/peer-file-reads";
import { RpcFailure } from "../../../../../src/main/features/remote/room";
import { ipcErr, ipcOk } from "../../../../../src/shared/ipc/result";

const {
  readPeerBinary,
  readPeerPiece,
  readPeerText,
  readPeerWorkspaceText,
  PEER_WORKSPACE_TEXT_LIMIT,
} = await import("../../../../../src/renderer/services/remote/peer-workspace");

const { FileLookBody, useFileLookView } = await import(
  "../../../../../src/renderer/components/chat/file-look"
);
const { watchPeerFile } = await import(
  "../../../../../src/renderer/services/remote/peer-file-live"
);

const { readWorkspaceRange } = await import(
  "../../../../../src/renderer/services/editor/preview/read-range"
);
const { readWorkspaceBinary } = await import(
  "../../../../../src/renderer/services/editor/preview/read-binary"
);

const PEER = { deviceId: "d1", workspaceId: "w1" };
let file = new Uint8Array(0);
let failAt: number | null = null;
let version: string | undefined;
let changeAt: number | null = null;
let downloaded = 0;
const prefixes: number[] = [];
const asked: {
  offset: number;
  length: number;
  path: string;
  versioned?: true;
  requireVersion?: string;
  ifVersion?: string;
}[] = [];
let setSchema: (schema: string) => void;
const globals = globalThis as Record<string, unknown>;
let saved: unknown;

beforeEach(() => {
  asked.length = 0;
  prefixes.length = 0;
  failAt = null;
  version = "first";
  changeAt = null;
  downloaded = 0;
  const cache = new PeerFileReads(async (_device, args) => {
    const offset = args.offset ?? 0;
    const length = args.length ?? MAX_BYTES_CHUNK;
    expect(length).toBeLessThanOrEqual(MAX_BYTES_CHUNK);
    asked.push({
      offset,
      length,
      path: args.path,
      versioned: args.versioned,
      requireVersion: args.requireVersion,
      ifVersion: args.ifVersion,
    });
    if (failAt === offset) throw new RpcFailure(RpcErrorCode.Forbidden, "gone");
    if (changeAt === offset) version = "changed";
    if (args.requireVersion && args.requireVersion !== version)
      throw new RpcFailure(RpcErrorCode.InvalidParams, "file version changed");
    if (version && args.ifVersion === version) return { kind: "notModified", version };
    const bytes = file.subarray(offset, offset + length);
    downloaded += bytes.length;
    return {
      kind: "bytes",
      path: args.path,
      data: Buffer.from(bytes).toString("base64"),
      offset,
      size: file.length,
      ...(version && (args.versioned || args.requireVersion || args.ifVersion) ? { version } : {}),
    };
  });
  setSchema = (schema) =>
    cache.updateRoom({
      status: "online",
      peers: [{ id: "d1", name: "peer", platform: "linux", online: true, schema }],
    });
  setSchema("0.13.4");
  saved = globals.window;
  globals.window = {
    ...((saved as object | undefined) ?? {}),
    ipc: {
      call: async (
        _channel: string,
        method: string,
        args: {
          deviceId: string;
          workspaceId: string;
          path: string;
          offset: number;
          length: number;
          maxBytes?: number;
          whole?: true;
          requireVersion?: string;
        },
      ) => {
        if (method === "peerFilesRead") {
          const maxBytes = args.maxBytes ?? 0;
          prefixes.push(maxBytes);
          const bytes = file.subarray(0, maxBytes);
          downloaded += bytes.length;
          return ipcOk({
            kind: bytes.subarray(0, 8000).includes(0) ? "binary" : "text",
            text: new TextDecoder().decode(bytes, { stream: true }),
            truncated: bytes.length < file.length,
            version,
          });
        }
        expect(method).toBe("peerFilesReadBytes");
        try {
          return ipcOk(
            await cache.readBytes(
              args,
              args.path,
              args.offset,
              args.length,
              !!args.whole,
              args.requireVersion,
            ),
          );
        } catch {
          return ipcErr("unavailable", "gone");
        }
      },
      cancel: () => {},
    },
  };
});

afterEach(() => {
  globals.window = saved;
});

const sized = (size: number) => {
  file = new Uint8Array(size);
  for (let i = 0; i < size; i++) file[i] = i % 251;
};

describe("another computer's file, read through the room", () => {
  test("a part larger than one request goes as several, put back together", async () => {
    sized(MAX_BYTES_CHUNK * 2 + 5);
    const piece = await readPeerPiece(PEER, "/w/a.pdf", 10, MAX_BYTES_CHUNK + 20);
    expect(piece?.size).toBe(file.length);
    expect(piece?.bytes.length).toBe(MAX_BYTES_CHUNK + 20);
    expect(piece?.bytes[MAX_BYTES_CHUNK]).toBe((10 + MAX_BYTES_CHUNK) % 251);
    expect(asked.map((a) => a.offset)).toEqual([10, 10 + MAX_BYTES_CHUNK]);
  });

  test("a whole file comes in pieces; one that cannot be read fails it", async () => {
    sized(MAX_BYTES_CHUNK * 3 + 1);
    const read = await readPeerBinary(PEER, "/w/a.docx");
    expect(read.kind).toBe("ok");
    if (read.kind === "ok") expect(read.bytes).toEqual(file);
    version = "second";
    failAt = MAX_BYTES_CHUNK * 2;
    expect((await readPeerBinary(PEER, "/w/a.docx")).kind).toBe("failed");
  });

  test("text is UTF-8 without its mark; a NUL near the start is a binary file", async () => {
    file = new TextEncoder().encode("\uFEFF# 제목\n");
    expect(await readPeerText(PEER, "/w/a.md")).toEqual({ kind: "text", text: "# 제목\n" });
    file = new Uint8Array([0x50, 0x4b, 0x00, 0x01]);
    expect(await readPeerText(PEER, "/w/a.bin")).toEqual({ kind: "binary" });
  });
});

test("whole-file and text reopen validate once, then reload a same-size change", async () => {
  const size = MAX_BYTES_CHUNK * 2 + 25;
  file = new Uint8Array(size).fill(65);
  const workspace = "peer:d1:w1";
  const path = "/w/same-size.txt";
  expect((await readPeerText(PEER, path)).kind).toBe("text");
  expect([asked.length, downloaded]).toEqual([3, size]);
  expect((await readWorkspaceBinary(workspace, path)).kind).toBe("ok");
  expect([asked.length, downloaded]).toEqual([4, size]);
  file.fill(66);
  version = "new";
  const read = await readPeerText(PEER, path);
  expect(read.kind === "text" && read.text[0]).toBe("B");
  expect([asked.length, downloaded]).toEqual([7, size * 2]);
});

test("PDF spans reuse the oversized opening prefix and pin later ranges", async () => {
  const size = 20 * 1024 * 1024;
  const headLength = MAX_BYTES_CHUNK * 2;
  sized(size);
  const path = "/w/big.pdf";
  const workspace = "peer:d1:w1";
  const head = await readWorkspaceRange(workspace, path, 0, headLength);
  expect(head?.mtime).toBe("version:first");
  expect([asked.length, downloaded]).toEqual([2, headLength]);
  expect((await readWorkspaceRange(workspace, path, 0, headLength))?.bytes).toEqual(head?.bytes);
  expect([asked.length, downloaded]).toEqual([3, headLength]);
  const later = 19 * 1024 * 1024;
  for (let i = 0; i < 2; i++) {
    expect((await readWorkspaceRange(workspace, path, later, 64, head?.mtime))?.bytes.length).toBe(
      64,
    );
  }
  expect([asked.length, downloaded]).toEqual([5, headLength + 128]);
  version = "edited";
  expect(await readWorkspaceRange(workspace, path, later, 64, head?.mtime)).toBeNull();
  expect([asked.length, downloaded]).toEqual([6, headLength + 128]);
});

test("a late generation mismatch fails a cold assembly; a versionless head keeps size fallback", async () => {
  sized(MAX_BYTES_CHUNK + 10);
  changeAt = MAX_BYTES_CHUNK;
  expect((await readPeerBinary(PEER, "/w/changed.bin")).kind).toBe("failed");
  version = undefined;
  const path = "/w/fresh.pdf";
  const head = await readWorkspaceRange("peer:d1:w1", path, 0, MAX_BYTES_CHUNK);
  expect(head?.mtime).toBe(`size:${file.length}`);
  expect(
    (await readWorkspaceRange("peer:d1:w1", path, MAX_BYTES_CHUNK, 10, head?.mtime))?.bytes.length,
  ).toBe(10);
});

test("unversioned 20 MiB PDFs use only the required data RPCs on old and new hosts", async () => {
  for (const schema of ["0.13.2", "0.13.4"]) {
    setSchema(schema);
    version = undefined;
    file = new Uint8Array(20 * 1024 * 1024);
    asked.length = 0;
    downloaded = 0;
    for (let i = 0; i < 2; i++) {
      const head = await readWorkspaceRange(
        "peer:d1:w1",
        "/w/unversioned.pdf",
        0,
        2 * MAX_BYTES_CHUNK,
      );
      expect(head?.bytes.length).toBe(2 * MAX_BYTES_CHUNK);
      expect(head?.mtime).toBe(`size:${file.length}`);
    }
    expect([asked.length, downloaded]).toEqual([4, 4 * MAX_BYTES_CHUNK]);
    expect(asked.map((r) => r.versioned)).toEqual(
      schema === "0.13.4"
        ? [true, undefined, true, undefined]
        : [undefined, undefined, undefined, undefined],
    );
    expect(asked.every((r) => r.length > 0 && !r.requireVersion && !r.ifVersion)).toBe(true);
  }
});

test("workspace text reads the full cache limit in byte chunks", async () => {
  file = new Uint8Array(PEER_WORKSPACE_TEXT_LIMIT).fill(65);
  const read = await readPeerWorkspaceText(PEER, "/w/full.txt");
  expect(read.text.kind).toBe("text");
  if (read.text.kind === "text") expect(read.text.text.length).toBe(file.length);
  expect(prefixes).toEqual([]);
  expect(asked[0]?.length).toBe(1);
  expect(downloaded).toBe(1 + file.length);
});

test("a large workspace file requests only its prefix and renders the read limit banner", async () => {
  file = new Uint8Array(PEER_WORKSPACE_TEXT_LIMIT + 1).fill(65);
  const workspaceId = "peer:d1:w1";
  const path = "/w/large.md";
  const loaded = Promise.withResolvers<void>();
  const stop = watchPeerFile(workspaceId, path, () => loaded.resolve(), "workspace-text");
  try {
    await loaded.promise;
    function Preview() {
      const view = useFileLookView(path, { mode: "preview" });
      return createElement(FileLookBody, {
        workspaceId,
        root: "/w",
        path,
        view,
        peerFile: { watch: true, connection: 0, toolbar: null },
      });
    }
    expect(renderToStaticMarkup(createElement(Preview))).toContain("Partial file · First 512 KB");
    expect(prefixes).toEqual([MAX_READ_BYTES]);
    expect(asked.map(({ length }) => length)).toEqual([1]);
    expect(downloaded).toBe(1 + MAX_READ_BYTES);
  } finally {
    stop();
  }
});

test("a Windows peer markdown preview resolves its relative images without a chat pane", async () => {
  file = new TextEncoder().encode("![Demo](./preview.png)");
  const workspaceId = "peer:d1:w1";
  const path = "c:\\Project\\Docs\\README.md";
  const loaded = Promise.withResolvers<void>();
  const stop = watchPeerFile(workspaceId, path, () => loaded.resolve(), "workspace-text");
  try {
    await loaded.promise;
    function Preview() {
      const view = useFileLookView(path, { mode: "preview" });
      return createElement(FileLookBody, {
        workspaceId,
        root: "C:/Project",
        path,
        view,
        peerFile: { watch: true, connection: 0, toolbar: null },
      });
    }
    expect(renderToStaticMarkup(createElement(Preview))).toContain(
      "nexus-workspace://peer/d1/w1/C%3A/Project/Docs/preview.png",
    );
  } finally {
    stop();
  }
});
