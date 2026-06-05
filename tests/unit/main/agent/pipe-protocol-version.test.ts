/**
 * Unit tests for protocolVersion validation in createNdjsonPipe (T3).
 *
 * The pipe checks the major version component of the ready frame's
 * protocolVersion against expectedProtocolMajor (default: the major of
 * AGENT_PROTOCOL_VERSION — the single source of truth in envelope.ts).
 * The protocolMajorMatches helper rules, with MAJOR = current major and
 * OTHER = a different major:
 *   - undefined      → PASS (backward-compat: old agent that never sent version)
 *   - MAJOR          → PASS (exact major match)
 *   - `MAJOR.0`      → PASS (major extracted by split(".",1)[0])
 *   - `MAJOR.5`      → PASS (major-only match; minor ignored)
 *   - `OTHER.0`      → FAIL → selfFail("server.protocol-version-mismatch")
 *   - ""             → FAIL (split("",1)[0] === "" !== MAJOR)
 *
 * Cases E–I per the T3 acceptance criteria, kept version-agnostic so a
 * protocol bump does not rewrite this file (v0.6.0 lesson).
 *
 * Helpers mirror pipe-ready-heartbeat.test.ts and pipe-void-response.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { AGENT_PROTOCOL_VERSION } from "../../../../src/shared/agent/envelope";
import { createNdjsonPipe } from "../../../../src/main/infra/agent/pipe";

const MAJOR = AGENT_PROTOCOL_VERSION.split(".", 1)[0];
const OTHER_MAJOR = String(Number(MAJOR) + 1);

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
  // Case E: `MAJOR.0` → major matches default expectedProtocolMajor → ready resolves
  test("Case E: protocolVersion `MAJOR.0` → ready resolves, no terminal error", async () => {
    const { stdout, pipe, getTerminalError } = buildPipe();

    stdout.emitData(readyFrameWith(`${MAJOR}.0`));
    await pipe.ready;

    expect(getTerminalError()).toBeNull();
    pipe.dispose();
  });

  // Case F: `OTHER.0` → different major → selfFail("server.protocol-version-mismatch")
  test("Case F: protocolVersion `OTHER.0` → terminal error \"server.protocol-version-mismatch\"", async () => {
    const { stdout, pipe, getTerminalError } = buildPipe();

    stdout.emitData(readyFrameWith(`${OTHER_MAJOR}.0`));

    // ready rejects because selfFail() calls rejectReady
    await expect(pipe.ready).rejects.toMatchObject({
      code: "server.protocol-version-mismatch",
    });

    const err = getTerminalError() as unknown as { code: string } | null;
    expect(err).not.toBeNull();
    expect(err?.code).toBe("server.protocol-version-mismatch");
  });

  // Case G: `MAJOR.5` → major matches → ready resolves (minor version ignored)
  test("Case G: protocolVersion `MAJOR.5` → ready resolves (major-only match)", async () => {
    const { stdout, pipe, getTerminalError } = buildPipe();

    stdout.emitData(readyFrameWith(`${MAJOR}.5`));
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

  // Case I: protocolVersion "" → split("",1)[0] === "" !== MAJOR → mismatch
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
