import { describe, expect, it } from "bun:test";
import {
  type ShellEntry,
  shellNamed,
} from "../../../../../src/renderer/services/terminal/installed-shells";

const entries: ShellEntry[] = [
  { choice: { kind: "detected", id: "/bin/zsh" }, name: "zsh", path: "/bin/zsh", args: [] },
  {
    choice: { kind: "detected", id: "git-bash" },
    name: "Git Bash",
    path: "C:\\Program Files\\Git\\bin\\bash.exe",
    args: ["--login", "-i"],
  },
  { choice: { kind: "custom", id: "c1" }, name: "Login bash", path: "bash", args: ["-l"] },
];

const pick = (name: string) => shellNamed(entries, name)?.choice;

describe("shellNamed", () => {
  it("takes the menu's name, ignoring case", () => {
    expect(pick("git bash")).toEqual({ kind: "detected", id: "git-bash" });
    expect(pick(" Login Bash ")).toEqual({ kind: "custom", id: "c1" });
  });

  it("takes the id, then the program's name", () => {
    expect(pick("/bin/zsh")).toEqual({ kind: "detected", id: "/bin/zsh" });
    expect(pick("c1")).toEqual({ kind: "custom", id: "c1" });
    // Both are a bash; the first listed wins.
    expect(pick("bash")).toEqual({ kind: "detected", id: "git-bash" });
  });

  it("finds nothing for a shell not listed", () => {
    expect(pick("fish")).toBeUndefined();
  });
});
