/**
 * Round-trip test for the agent NDJSON channel.
 *
 * The purpose is drift detection between the TS protocol schemas
 * (`src/shared/protocol/agent/*.ts`) and the Go implementation
 * (`internal/fsops/*.go`). The test spawns the real agent binary via
 * the production `createLocalChannel` factory — so any regression in that
 * factory also surfaces here. Three response paths are exercised on the same
 * channel so the envelope's result/error variants both round-trip cleanly:
 *   1. Ready frame on boot
 *   2. Success result variant (kind="ok")
 *   3. Conflict result variant (kind="conflict")
 *   4. Server error frame (code=OUT_OF_WORKSPACE)
 *
 * The Go agent handles each request on its own goroutine, so response order
 * is not guaranteed to match request order. The channel's pipe demultiplexes
 * by `id` internally; this test just awaits N promises in parallel.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocalChannel } from "../../../src/main/agent/local-channel";
import { AGENT_PROTOCOL_VERSION } from "../../../src/shared/protocol/agent/envelope";
import { AgentFsErrorCodeSchema } from "../../../src/shared/protocol/agent/errors";
import {
  type FsWriteFileParams,
  FsWriteFileResultSchema,
} from "../../../src/shared/protocol/agent/fs";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

const goAvailable = spawnSync("go", ["version"]).status === 0;

describe("agent fs.writeFile round-trip", () => {
  if (!goAvailable) {
    it("skips when go is unavailable", () => {});
    return;
  }

  let binPath: string;
  let buildDir: string;

  beforeAll(async () => {
    buildDir = await fs.mkdtemp(path.join(tmpdir(), "agent-build-"));
    binPath = path.join(buildDir, "agent");
    const build = spawnSync("go", ["build", "-o", binPath, "./cmd/agent"], {
      cwd: REPO_ROOT,
    });
    if (build.status !== 0) {
      throw new Error(`go build failed: ${build.stderr.toString()}`);
    }
  });

  afterAll(async () => {
    if (buildDir) {
      await fs.rm(buildDir, { recursive: true, force: true });
    }
  });

  it("emits ready, then ok / conflict / error responses that match the TS schemas", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "agent-root-"));
    const channel = createLocalChannel({ binaryPath: binPath, rootPath: root });

    try {
      // 1. Ready frame — channel.ready resolves once the server emits it.
      // The channel parses the boot frame internally; the protocol-version
      // check happens inside the pipe and would surface as a ready rejection.
      await channel.ready;

      // 2. Ok variant — first write of a new file.
      const okParams: FsWriteFileParams = {
        relPath: "hello.txt",
        content: "world",
        expected: { exists: false },
      };
      const okResult = FsWriteFileResultSchema.parse(
        await channel.call("fs.writeFile", okParams),
      );
      expect(okResult.kind).toBe("ok");
      const written = await fs.readFile(path.join(root, "hello.txt"), "utf8");
      expect(written).toBe("world");

      // 3. Conflict variant — expected:false but the file now exists. The
      // server returns this as a success-shaped frame (channel resolves) with
      // a discriminated `kind: "conflict"` payload, not as an error frame.
      const conflictResult = FsWriteFileResultSchema.parse(
        await channel.call("fs.writeFile", {
          relPath: "hello.txt",
          content: "v2",
          expected: { exists: false },
        }),
      );
      expect(conflictResult.kind).toBe("conflict");
      if (conflictResult.kind === "conflict") {
        expect(conflictResult.actual.exists).toBe(true);
      }

      // 4. Error frame — path escape rejected by Resolve. The channel rejects
      // the call with an Error whose `code` is the server's wire code.
      const errorCode = await callExpectErrorCode(channel, "fs.writeFile", {
        relPath: "../escape.txt",
        content: "x",
      });
      expect(AgentFsErrorCodeSchema.parse(errorCode)).toBe("OUT_OF_WORKSPACE");

      // Sanity: protocol version constant is what the integration test
      // expects today. If the Go side bumps it without TS following, the
      // ready handshake would have already failed before we got here.
      expect(AGENT_PROTOCOL_VERSION).toBe("1");
    } finally {
      channel.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * Wraps `channel.call` to assert the rejection path and surface the wire
 * `code` attached to the thrown Error. The pipe attaches `code` whenever the
 * server frame carries a string `code`, which the Go side always does.
 */
async function callExpectErrorCode(
  channel: ReturnType<typeof createLocalChannel>,
  method: string,
  params: unknown,
): Promise<string> {
  try {
    const result = await channel.call(method, params);
    throw new Error(
      `expected error for ${method}, got result: ${JSON.stringify(result)}`,
    );
  } catch (error) {
    const code = (error as Error & { code?: string }).code;
    if (typeof code !== "string") {
      throw new Error(
        `expected error.code on rejection for ${method}, got: ${(error as Error).message}`,
      );
    }
    return code;
  }
}
