import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { createNdjsonPipe, createSshError } from "../../../../src/main/infra/agent/pipe";
import { mainWarnMock } from "../../../log-test-spies";

test("agent diagnostics mask credentials before generating a preview", async () => {
  const start = mainWarnMock.mock.calls.length;
  const detail = "fetch https://user-fixture:password-fixture@example.test?token=query-fixture&v=2";
  const error = createSshError("server.spawn-failed", new Error(detail));
  expect(error.cause).toMatchObject({ message: detail });

  const stdout = new PassThrough();
  const pipe = createNdjsonPipe({
    stdout,
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    classifyStderr: () => null,
    onTerminalError: () => {},
  });
  const ready = pipe.ready.catch((failure: unknown) => failure);
  stdout.write(
    `login https://${"x".repeat(256)}long-credential@example.test Authorization: Bearer bearer-fixture APP_SECRET="quoted fixture"\n`,
  );
  expect(await ready).toMatchObject({ code: "server.protocol-error" });
  const messages = mainWarnMock.mock.calls
    .slice(start)
    .map(([message]) => message)
    .join("\n");
  expect(messages).toContain("stdout NDJSON parse failed");
  expect(messages).toContain("example.test");
  for (const secret of [
    "user-fixture",
    "password-fixture",
    "query-fixture",
    "x".repeat(30),
    "bearer-fixture",
    "quoted fixture",
  ]) {
    expect(messages).not.toContain(secret);
  }
  pipe.dispose();
});
