import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createProtocolErrorResponse,
  createServerDispatcher,
  idFromMalformedLine,
} from "../../../src/server/dispatch";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nexus-server-dispatch-"));
});

afterEach(async () => {
  await fs.promises.rm(tmpRoot, { recursive: true, force: true });
});

function expectIsoDate(value: string) {
  expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  expect(Number.isNaN(Date.parse(value))).toBe(false);
}

describe("server dispatch", () => {
  it("dispatches fs.readdir against the root path", async () => {
    await fs.promises.writeFile(path.join(tmpRoot, "alpha.txt"), "alpha", "utf8");
    await fs.promises.mkdir(path.join(tmpRoot, "src"));

    const dispatch = createServerDispatcher(tmpRoot);
    const response = await dispatch({
      id: "readdir-1",
      method: "fs.readdir",
      params: { relPath: "." },
    });

    expect(response).toEqual({
      id: "readdir-1",
      result: [
        { name: "alpha.txt", type: "file" },
        { name: "src", type: "dir" },
      ],
    });
  });

  it("dispatches fs.stat against the root path", async () => {
    const filePath = path.join(tmpRoot, "note.txt");
    await fs.promises.writeFile(filePath, "hello", "utf8");

    const dispatch = createServerDispatcher(tmpRoot);
    const response = await dispatch({
      id: "stat-1",
      method: "fs.stat",
      params: { relPath: "note.txt" },
    });

    expect(response.id).toBe("stat-1");
    if (!("result" in response)) {
      throw new Error("expected successful fs.stat response");
    }

    expect(response.result).toEqual({
      type: "file",
      size: 5,
      mtime: expect.any(String),
      isSymlink: false,
    });
    expectIsoDate((response.result as { mtime: string }).mtime);
  });

  it("dispatches fs.readFile against the root path", async () => {
    const content = "export const value = 42;\n";
    await fs.promises.writeFile(path.join(tmpRoot, "entry.ts"), content, "utf8");

    const dispatch = createServerDispatcher(tmpRoot);
    const response = await dispatch({
      id: "read-1",
      method: "fs.readFile",
      params: { relPath: "entry.ts" },
    });

    expect(response.id).toBe("read-1");
    if (!("result" in response)) {
      throw new Error("expected successful fs.readFile response");
    }

    expect(response.result).toEqual({
      kind: "ok",
      content,
      encoding: "utf8",
      sizeBytes: Buffer.byteLength(content, "utf8"),
      isBinary: false,
      mtime: expect.any(String),
    });
    expectIsoDate((response.result as { mtime: string }).mtime);
  });

  it("builds a server.protocol-error response for malformed JSON requests", () => {
    const malformedLine = '{"id":"bad-json","method":"fs.readdir","params":';
    const id = idFromMalformedLine(malformedLine) ?? "server-protocol-error";

    expect(createProtocolErrorResponse(id, "malformed JSON")).toEqual({
      id: "bad-json",
      error: { code: "server.protocol-error", message: "malformed JSON" },
    });
  });

  it("returns a method not supported error for unsupported methods", async () => {
    const dispatch = createServerDispatcher(tmpRoot);

    const response = await dispatch({
      id: "unsupported-1",
      method: "fs.writeFile",
      params: { relPath: "entry.ts" },
    });

    expect(response).toEqual({
      id: "unsupported-1",
      error: {
        code: "unsupported-method",
        message: "method not supported: fs.writeFile",
      },
    });
  });
});
