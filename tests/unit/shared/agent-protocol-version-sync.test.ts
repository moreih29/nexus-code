import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { AGENT_PROTOCOL_VERSION } from "../../../src/shared/agent/envelope";

/**
 * Cross-language drift guard for the agent protocol version.
 *
 * The protocol major lives in exactly two places — Go (`internal/proto/
 * proto.go`, advertised on the Ready frame) and TS (`src/shared/agent/
 * envelope.ts`, the expected value every channel validates against). All
 * other TS sites must alias the envelope constant.
 *
 * v0.6.0 shipped with the Go side at "2" and the local channel's expectation
 * still at "1": every local workspace failed the Ready handshake with
 * `server.protocol-version-mismatch` and the release had to be pulled.
 * Round-trip schema tests cannot catch this class of bug — the envelope
 * SHAPE was compatible; only the advertised version diverged. This test
 * reads the Go source directly so any future one-sided bump fails CI.
 */
describe("agent protocol version sync", () => {
  it("Go proto.go ProtocolVersion matches TS AGENT_PROTOCOL_VERSION", () => {
    const protoGo = fs.readFileSync(
      path.join(__dirname, "../../../internal/proto/proto.go"),
      "utf8",
    );
    const match = protoGo.match(/ProtocolVersion\s*=\s*"([^"]+)"/);
    expect(match).not.toBeNull();

    const goMajor = (match as RegExpMatchArray)[1].split(".", 1)[0];
    const tsMajor = AGENT_PROTOCOL_VERSION.split(".", 1)[0];
    expect(goMajor).toBe(tsMajor);
  });

  it("SSH channel expectation aliases the envelope constant", async () => {
    const { REMOTE_AGENT_PROTOCOL_MAJOR } = await import(
      "../../../src/main/infra/agent/ssh/ssh-bootstrap/types"
    );
    expect(REMOTE_AGENT_PROTOCOL_MAJOR).toBe(AGENT_PROTOCOL_VERSION);
  });
});
