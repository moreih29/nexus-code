import { describe, expect, test } from "bun:test";
import { classifyStderrLine } from "../../../../src/main/infra/agent/ssh/stderr-patterns";

// Regression coverage for the dynamic-loader patterns. These were added after a
// glibc-too-old failure surfaced as an empty-cause `ssh.unknown` (the agent
// binary was dynamically linked against a newer glibc than the remote had).
// Classifying them as `server.spawn-failed` gives the user "Remote agent failed
// to start" instead of the generic transport error, and the offending line is
// attached as the SshError cause in the file log.
describe("classifyStderrLine — agent loader failures", () => {
  test("glibc version mismatch", () => {
    const line =
      "agent: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.34' not found (required by agent)";
    expect(classifyStderrLine(line)).toBe("server.spawn-failed");
  });

  test("missing shared library", () => {
    expect(
      classifyStderrLine("agent: error while loading shared libraries: libfoo.so.1: cannot open"),
    ).toBe("server.spawn-failed");
  });

  test("architecture mismatch", () => {
    expect(classifyStderrLine("bash: /x/agent: cannot execute binary file: Exec format error")).toBe(
      "server.spawn-failed",
    );
  });

  test("benign login banner is not misclassified", () => {
    expect(classifyStderrLine("Welcome to monolith! Have a great day.")).toBeNull();
  });

  test("existing auth/connect classification is unchanged", () => {
    expect(classifyStderrLine("Permission denied (publickey).")).toBe("ssh.auth-failed");
    expect(classifyStderrLine("ssh: connect to host x port 22: Connection refused")).toBe(
      "ssh.connect-failed",
    );
  });
});
