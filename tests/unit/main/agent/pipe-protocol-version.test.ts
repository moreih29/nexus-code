/**
 * Unit tests for protocolVersion validation in createNdjsonPipe (T3).
 *
 * The pipe checks the major version component of the ready frame's
 * protocolVersion against expectedProtocolMajor (default "1"). The
 * protocolMajorMatches helper at pipe.ts:730 rules:
 *   - undefined  → PASS (backward-compat: old agent that never sent version)
 *   - "1"        → PASS (exact major match)
 *   - "1.0"      → PASS (major "1" extracted by split(".",1)[0])
 *   - "1.5"      → PASS (major-only match; minor ignored)
 *   - "2.0"      → FAIL → selfFail("server.protocol-version-mismatch")
 *   - ""         → FAIL (split("",1)[0] === "" !== "1")
 *
 * Cases E–I per the T3 acceptance criteria.
 *
 * Helpers mirror pipe-ready-heartbeat.test.ts and pipe-void-response.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { createNdjsonPipe } from "../../../../src/main/infra/agent/pipe";

// ---------------------------------------------------------------------------
// Minimal fake stream helpers (same pattern as pipe-void-response.test.ts)
// ---------------------------------------------------------------------------

class FakeReadable extends EventEmitter {
  pause(): this {
    return this;
  }
  resume(): this {
    return this;
  }
  emitData(chunk: Buffer): void {
    this.emit("data", chunk);
  }
}

class FakeWritable {
  readonly writes: string[] = [];
  writable = true;
  destroyed = false;

  write(line: string, callback?: (error?: Error | null) => void): boolean {
    this.writes.push(line);
    callback?.();
    return true;
  }
}

// ---------------------------------------------------------------------------
// Helper — build a pipe and capture the terminal error
// ---------------------------------------------------------------------------

function buildPipe(extraOptions: { expectedProtocolMajor?: string } = {}): {
  stdout: FakeReadable;
  pipe: ReturnType<typeof createNdjsonPipe>;
  getTerminalError: () => Error | null;
} {
  const stdout = new FakeReadable();
  const stderr = new FakeReadable();
  const stdin = new FakeWritable();
  let terminalError: Error | null = null;

  const pipe = createNdjsonPipe({
    stdout: stdout as unknown as Readable,
    stderr: stderr as unknown as Readable,
    stdin: stdin as unknown as Writable,
    classifyStderr: () => null,
    onTerminalError: (err) => {
      terminalError = err;
    },
    ...extraOptions,
  });

  return {
    stdout,
    pipe,
    getTerminalError: () => terminalError,
  };
}

function readyFrameWith(protocolVersion: string | undefined): Buffer {
  const obj: Record<string, unknown> = { type: "ready" };
  if (protocolVersion !== undefined) {
    obj.protocolVersion = protocolVersion;
  }
  return Buffer.from(JSON.stringify(obj) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// protocolVersion validation — Cases E–I
// ---------------------------------------------------------------------------

describe("createNdjsonPipe — protocolVersion validation", () => {
  // Case E: "1.0" → major "1" matches expectedProtocolMajor "1" → ready resolves
  test('Case E: protocolVersion "1.0" → ready resolves, no terminal error', async () => {
    const { stdout, pipe, getTerminalError } = buildPipe();

    stdout.emitData(readyFrameWith("1.0"));
    await pipe.ready;

    expect(getTerminalError()).toBeNull();
    pipe.dispose();
  });

  // Case F: "2.0" → major "2" !== "1" → selfFail("server.protocol-version-mismatch")
  test('Case F: protocolVersion "2.0" → terminal error "server.protocol-version-mismatch"', async () => {
    const { stdout, pipe, getTerminalError } = buildPipe();

    stdout.emitData(readyFrameWith("2.0"));

    // ready rejects because selfFail() calls rejectReady
    await expect(pipe.ready).rejects.toMatchObject({
      code: "server.protocol-version-mismatch",
    });

    const err = getTerminalError() as unknown as { code: string } | null;
    expect(err).not.toBeNull();
    expect(err?.code).toBe("server.protocol-version-mismatch");
  });

  // Case G: "1.5" → major "1" matches → ready resolves (minor version ignored)
  test('Case G: protocolVersion "1.5" → ready resolves (major-only match)', async () => {
    const { stdout, pipe, getTerminalError } = buildPipe();

    stdout.emitData(readyFrameWith("1.5"));
    await pipe.ready;

    expect(getTerminalError()).toBeNull();
    pipe.dispose();
  });

  // Case H: protocolVersion undefined → protocolMajorMatches returns true → ready resolves
  test("Case H: protocolVersion undefined → ready resolves (backward-compat pass)", async () => {
    const { stdout, pipe, getTerminalError } = buildPipe();

    stdout.emitData(readyFrameWith(undefined));
    await pipe.ready;

    expect(getTerminalError()).toBeNull();
    pipe.dispose();
  });

  // Case I: protocolVersion "" → split("",1)[0] === "" !== "1" → mismatch
  test('Case I: protocolVersion "" → terminal error "server.protocol-version-mismatch"', async () => {
    const { stdout, pipe, getTerminalError } = buildPipe();

    stdout.emitData(readyFrameWith(""));

    await expect(pipe.ready).rejects.toMatchObject({
      code: "server.protocol-version-mismatch",
    });

    const err = getTerminalError() as unknown as { code: string } | null;
    expect(err).not.toBeNull();
    expect(err?.code).toBe("server.protocol-version-mismatch");
  });
});
