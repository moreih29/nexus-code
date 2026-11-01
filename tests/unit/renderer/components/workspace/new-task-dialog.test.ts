import { describe, expect, it } from "bun:test";
import {
  newTaskFields,
  taskFailureMessage,
} from "../../../../../src/renderer/components/workspace/new-task-dialog";

describe("newTaskFields", () => {
  it("asks for a name and an optional prompt for the agent command", () => {
    const fields = newTaskFields("claude");

    expect(fields.map((f) => [f.name, f.required !== false])).toEqual([
      ["name", true],
      ["prompt", false],
    ]);
    expect(fields[1].helperText).toContain("claude");
  });

  it("asks for no prompt when no command runs", () => {
    expect(newTaskFields("").map((f) => f.name)).toEqual(["name"]);
  });
});

describe("taskFailureMessage", () => {
  it("explains the failures the user can act on", () => {
    expect(taskFailureMessage({ kind: "not-a-repo", message: "x" }, "notes")).toBe(
      "notes is not in a Git repository.",
    );
    expect(taskFailureMessage({ kind: "not-connected", message: "x" }, "box")).toBe(
      "Connect to box first.",
    );
  });

  it("shows git's own message otherwise", () => {
    expect(
      taskFailureMessage({ kind: "git-error", message: "fatal: invalid reference" }, "repo"),
    ).toBe("fatal: invalid reference");
  });
});
