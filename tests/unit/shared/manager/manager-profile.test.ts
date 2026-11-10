/**
 * The session the agent manager may go on with, which lives in the folder
 * of the profile it was made with.
 */
import { describe, expect, it } from "bun:test";
import { sessionFits } from "../../../../src/shared/manager/manager";

describe("sessionFits", () => {
  it("takes the session of the same agent and profile", () => {
    expect(sessionFits({ agent: "claude", profileId: "work" }, "claude", "work")).toBe(true);
  });

  it("leaves another profile's session, and another agent's", () => {
    expect(sessionFits({ agent: "claude", profileId: "work" }, "claude", "claude-default")).toBe(
      false,
    );
    expect(sessionFits({ agent: "codex", profileId: "work" }, "claude", "work")).toBe(false);
  });

  it("takes a session saved before sessions kept their profile", () => {
    expect(sessionFits({ agent: "claude" }, "claude", "work")).toBe(true);
    expect(sessionFits({ agent: "codex" }, "claude", "work")).toBe(false);
  });
});
