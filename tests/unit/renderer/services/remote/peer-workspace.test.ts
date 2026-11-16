import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MAX_BYTES_CHUNK } from "../../../../../packages/remote-protocol/src/rpc";

const { readPeerBinary, readPeerPiece, readPeerText } = await import(
  "../../../../../src/renderer/services/remote/peer-workspace"
);

const PEER = { deviceId: "d1", workspaceId: "w1" };
let file = new Uint8Array(0);
let failAt: number | null = null;
const asked: { offset: number; length: number; path: string }[] = [];
const globals = globalThis as Record<string, unknown>;
let saved: unknown;

beforeEach(() => {
  asked.length = 0;
  failAt = null;
  saved = globals.window;
  globals.window = {
    ...((saved as object | undefined) ?? {}),
    ipc: {
      call: async (_channel: string, method: string, args: Record<string, number & string>) => {
        expect(method).toBe("peerFilesRead");
        expect(args.as).toBe("bytes");
        expect(args.length).toBeLessThanOrEqual(MAX_BYTES_CHUNK);
        asked.push({ offset: args.offset, length: args.length, path: args.path });
        if (failAt === args.offset) return { ok: false, message: "gone" };
        const bytes = file.subarray(args.offset, args.offset + args.length);
        return {
          __nexusIpcResult_a3f8b1d2: true,
          ok: true,
          value: {
            kind: "bytes",
            path: args.path,
            data: Buffer.from(bytes).toString("base64"),
            offset: args.offset,
            size: file.length,
          },
        };
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
