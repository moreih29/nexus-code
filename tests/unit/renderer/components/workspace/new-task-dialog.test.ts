import { describe, expect, it } from "bun:test";
import {
  newTaskFields,
  taskFailureMessage,
} from "../../../../../src/renderer/components/workspace/new-task-dialog";

describe("newTaskFields", () => {
  it("asks for a name and an optional first message for the agent's tab", () => {
    const fields = newTaskFields("codex");

    expect(fields.map((f) => [f.name, f.required !== false])).toEqual([
      ["name", true],
      ["prompt", false],
    ]);
    expect(fields[1].helperText).toContain("Codex tab");
  });

  it("asks for no prompt for a terminal", () => {
    expect(newTaskFields("terminal").map((f) => f.name)).toEqual(["name"]);
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
