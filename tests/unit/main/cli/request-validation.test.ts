import { expect, test } from "bun:test";
import {
  type SetupCliFeatureOptions,
  setupCliFeature,
} from "../../../../src/main/features/cli/index";
import { CliRequestSchema, type CliResult } from "../../../../src/shared/cli/protocol";

const request = {
  requestId: "request-1",
  workspaceId: "w".repeat(64),
  tabId: "t".repeat(64),
  request: { argv: ["chat", "new"], cwd: "/repo", tempDir: "/tmp" },
  verified: false,
};

test("the CLI accepts caller IDs at the layout limit without a verified tab token", () => {
  expect(CliRequestSchema.parse(request)).toEqual(request);
});

test.each([
  "workspaceId",
  "tabId",
] as const)("the CLI rejects an unverified request with an oversized %s", (field) => {
  const oversized = { ...request, [field]: "x".repeat(65) };
  const parsed = CliRequestSchema.safeParse(oversized);
  expect(parsed.error?.issues).toMatchObject([{ code: "too_big", path: [field] }]);
});

test("main replies to an unverified CLI request with an oversized tab ID before dispatch", async () => {
  const reply = Promise.withResolvers<{ requestId: string; response: CliResult }>();
  let receive: ((payload: unknown) => void) | undefined;
  const feature = setupCliFeature({
    agentHost: {
      on(event: string, handler: (payload: unknown) => void) {
        if (event === "cli.request") receive = handler;
        return () => {};
      },
    },
    workspaceManager: {
      tryGetAgentChannel: async (workspaceId: string) => {
        expect(workspaceId).toBe(request.workspaceId);
        return {
          call: async (method: string, args: { requestId: string; response: CliResult }) => {
            expect(method).toBe("cli.respond");
            reply.resolve(args);
          },
        };
      },
    },
    getWindow: () => null,
    settings: () => {
      throw new Error("invalid request reached command dispatch");
    },
  } as unknown as SetupCliFeatureOptions);
  try {
    if (!receive) throw new Error("missing CLI listener");
    receive({ ...request, tabId: "t".repeat(65) });
    expect(await reply.promise).toEqual({
      requestId: request.requestId,
      response: { stdout: "", stderr: "nexus: invalid CLI request\n", exitCode: 1 },
    });
  } finally {
    feature.dispose();
  }
});
