import { describe, expect, test } from "bun:test";
import { createLocalChannel } from "../../../../src/main/infra/agent/channel/local-channel";
import { mainInfoMock, mainWarnMock } from "../../../log-test-spies";

const ROOT = "/Users/someone/secret-project";

describe("agent channel log lines", () => {
  test("carry neither the workspace path nor a path inside an error", async () => {
    mainInfoMock.mockClear();
    mainWarnMock.mockClear();
    try {
      createLocalChannel(
        { binaryPath: "/opt/agent", rootPath: ROOT },
        {
          spawn: () => {
            throw new Error(`spawn /Users/someone/bin/agent ENOENT`);
          },
        },
      );
    } catch {}
    const lines = [...mainInfoMock.mock.calls, ...mainWarnMock.mock.calls].map((c) => String(c[0]));
    const agentLines = lines.filter((l) => l.startsWith("[local:"));
    expect(agentLines.length).toBeGreaterThan(0);
    for (const line of agentLines) {
      expect(line).not.toContain("/Users/");
      expect(line).not.toContain("secret-project");
      expect(line).toMatch(/^\[local:[0-9a-f]{8}\]/);
    }
  });
});
