import { AGENT_PROTOCOL_VERSION } from "../../../src/shared/agent/envelope";
import { describe, expect, test } from "bun:test";
import { AgentManifestSchema } from "../../../src/shared/agent/manifest";

// Minimal valid manifest fixture — reused across tests.
const BASE_MANIFEST = {
  version: "0.1.0",
  protocolVersion: AGENT_PROTOCOL_VERSION,
  binaries: [
    {
      os: "linux",
      arch: "amd64",
      path: "agent-0.1.0-linux-amd64",
      sha256: "a".repeat(64),
      size: 1024,
    },
  ],
  runtime: {
    node: [
      {
        os: "linux",
        arch: "amd64",
        version: "v20.19.0",
        path: "runtime/node-v20.19.0-linux-x64.tar.gz",
        sha256: "b".repeat(64),
        size: 2048,
        entry: "bin/node",
      },
    ],
  },
  lspBinaries: [],
};

describe("AgentManifestSchema — wrapper field", () => {
  // Acceptance test 1: wrapper 필드 있는 manifest → round-trip
  test("wrapper 필드 포함 manifest round-trip", () => {
    const input = {
      ...BASE_MANIFEST,
      wrapper: {
        path: "bin/claude",
        sha256: "c".repeat(64),
        size: 512,
      },
    };
    const parsed = AgentManifestSchema.parse(input);
    expect(parsed.wrapper).toEqual({
      path: "bin/claude",
      sha256: "c".repeat(64),
      size: 512,
    });
    expect(parsed.version).toBe("0.1.0");
    expect(parsed.binaries).toHaveLength(1);
  });

  // Acceptance test 2: wrapper 필드 없는 구버전 manifest → parse 성공, wrapper === undefined
  test("wrapper 필드 없는 구버전 manifest 파싱 성공 (wrapper === undefined)", () => {
    const parsed = AgentManifestSchema.parse(BASE_MANIFEST);
    expect(parsed.wrapper).toBeUndefined();
  });

  test("wrapper sha256이 64자리 lowercase hex가 아닌 경우 parse 실패", () => {
    const input = {
      ...BASE_MANIFEST,
      wrapper: {
        path: "bin/claude",
        sha256: "INVALID_SHA256",
        size: 512,
      },
    };
    expect(() => AgentManifestSchema.parse(input)).toThrow();
  });

  test("wrapper size가 음수이면 parse 실패", () => {
    const input = {
      ...BASE_MANIFEST,
      wrapper: {
        path: "bin/claude",
        sha256: "d".repeat(64),
        size: -1,
      },
    };
    expect(() => AgentManifestSchema.parse(input)).toThrow();
  });

  test("wrapper path가 빈 문자열이면 parse 실패", () => {
    const input = {
      ...BASE_MANIFEST,
      wrapper: {
        path: "",
        sha256: "e".repeat(64),
        size: 512,
      },
    };
    expect(() => AgentManifestSchema.parse(input)).toThrow();
  });
});
