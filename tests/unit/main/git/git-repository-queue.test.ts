import { describe, expect, test } from "bun:test";
import type { GitExecutor } from "../../../../src/main/features/git/bridge/types";
import { GitRepository } from "../../../../src/main/features/git/domain/repository";
import type { GitStatus } from "../../../../src/shared/git/types";
import { stubMetadataReader } from "./helpers/local-semantic-executor";

describe("GitRepository operation queue", () => {
  test("serializes a slow status read before a concurrently requested stage", async () => {
    const log: string[] = [];
    let finishStatus!: () => void;
    const statusHeld = new Promise<void>((resolve) => {
      finishStatus = resolve;
    });
    const executor: GitExecutor = {
      async status() {
        log.push("status:start");
        await statusHeld;
        log.push("status:end");
        return {} as GitStatus;
      },
      async run({ args }) {
        log.push(`${args[0]}:start`, `${args[0]}:end`);
        return { stdout: "", stderr: "", code: 0 };
      },
      async *stream() {},
    };
    const repo = new GitRepository(
      "workspace",
      "/repo",
      "/repo/.git",
      "git",
      executor,
      stubMetadataReader,
    );

    const slowRead = repo.status();
    const fastWrite = repo.stage(["queued.txt"]);

    // Drain microtasks: the stage must still be waiting behind the held status.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(log).toEqual(["status:start"]);

    finishStatus();
    await Promise.all([slowRead, fastWrite]);

    expect(log).toEqual(["status:start", "status:end", "add:start", "add:end"]);
  });
});
