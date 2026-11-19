import { expect, mock, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { collectProcess } from "../../../../src/main/infra/agent/collect-process";

test("terminates a transport command whose combined output exceeds the collection limit", async () => {
  const kill = mock(() => true);
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill,
  });
  const result = collectProcess(child as unknown as ChildProcessWithoutNullStreams, {
    name: "ssh",
    timeoutMs: 30_000,
  });
  child.stdout.write(Buffer.alloc(4 * 1024 * 1024));
  child.stderr.write("over the limit");
  child.emit("close", 0);

  await expect(result).rejects.toMatchObject({ code: "transport.unknown" });
  expect(kill).toHaveBeenCalledTimes(1);
  expect(kill).toHaveBeenCalledWith("SIGKILL");
});
