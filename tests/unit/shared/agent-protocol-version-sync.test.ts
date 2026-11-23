import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { AGENT_PROTOCOL_VERSION } from "../../../src/shared/agent/envelope";

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
