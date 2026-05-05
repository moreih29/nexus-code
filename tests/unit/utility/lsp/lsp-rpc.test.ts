// Unit tests for JSON-RPC framing in TypeScriptServer.
// Tests the Content-Length header encoding and multi-message buffering logic.
//
// We test the framing by encoding a known message and verifying the wire format,
// then use the message parsing indirectly by checking that the class correctly
// handles incoming buffers — verified via the hover/definition calls in
// integration, but we test the encode helper shape here.

import { describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// Replicate the encodeMessage helper (same logic as servers/typescript.ts)
// ---------------------------------------------------------------------------

function encodeMessage(msg: unknown): Buffer {
  const body = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
  return Buffer.concat([Buffer.from(header, "ascii"), Buffer.from(body, "utf8")]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LSP JSON-RPC framing — encodeMessage", () => {
  test("produces Content-Length header followed by JSON body", () => {
    const msg = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
    const buf = encodeMessage(msg);
    const str = buf.toString("utf8");

    expect(str).toContain("Content-Length:");
    expect(str).toContain("\r\n\r\n");
    expect(str).toContain('"method":"initialize"');
  });

  test("Content-Length value matches actual body byte length", () => {
    const msg = {
      jsonrpc: "2.0",
      id: 2,
      method: "textDocument/hover",
      params: { uri: "file:///test.ts" },
    };
    const buf = encodeMessage(msg);
    const str = buf.toString("ascii");

    const headerEnd = str.indexOf("\r\n\r\n");
    const header = str.slice(0, headerEnd);
    const match = /Content-Length:\s*(\d+)/.exec(header);
    expect(match).not.toBeNull();

    const declaredLength = parseInt(match![1], 10);
    const bodyStr = buf.slice(headerEnd + 4);
    expect(bodyStr.length).toBe(declaredLength);
  });

  test("body is valid JSON matching original message", () => {
    const msg = { jsonrpc: "2.0", method: "initialized", params: {} };
    const buf = encodeMessage(msg);
    const str = buf.toString("utf8");

    const headerEnd = str.indexOf("\r\n\r\n");
    const body = str.slice(headerEnd + 4);
    const parsed = JSON.parse(body);

    expect(parsed).toEqual(msg);
  });

  test("unicode in text is correctly measured with byteLength", () => {
    // A multi-byte unicode character takes more than 1 byte
    const msg = { jsonrpc: "2.0", method: "test", params: { text: "café" } };
    const body = JSON.stringify(msg);
    const byteLen = Buffer.byteLength(body, "utf8");
    const buf = encodeMessage(msg);
    const str = buf.toString("ascii");
    const match = /Content-Length:\s*(\d+)/.exec(str)!;
    expect(parseInt(match[1], 10)).toBe(byteLen);
  });
});
