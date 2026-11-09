/**
 * The profile the agent manager runs with: the one chosen for its agent, or
 * the agent's default; and the session it may go on with, which lives in
 * the folder of the profile it was made with.
 */
import { describe, expect, it } from "bun:test";
import type { AgentProfiles } from "../../../../src/shared/agent-profiles/profiles";
import { managerProfileOf, sessionFits } from "../../../../src/shared/manager/manager";

const config: AgentProfiles = {
  profiles: [
    { id: "work", agent: "claude", name: "Work", color: "violet", dir: "~/.claude-work" },
    { id: "codex-work", agent: "codex", name: "Work", color: "green", dir: "~/.codex-work" },
  ],
  rules: [],
  defaults: {},
};

describe("managerProfileOf", () => {
  it("is the agent's default profile when none is chosen", () => {
    expect(managerProfileOf(config, "claude", undefined).id).toBe("claude-default");
    const withDefault = { ...config, defaults: { claude: "work" } };
    expect(managerProfileOf(withDefault, "claude", undefined).id).toBe("work");
  });

  it("is the one chosen, over the default", () => {
    const withDefault = { ...config, defaults: { claude: "work" } };
    expect(managerProfileOf(withDefault, "claude", "claude-default").id).toBe("claude-default");
    expect(managerProfileOf(config, "codex", "codex-work").id).toBe("codex-work");
  });

  it("goes back to the default when the one chosen is gone or another agent's", () => {
    const withDefault = { ...config, defaults: { claude: "work" } };
    expect(managerProfileOf(withDefault, "claude", "removed").id).toBe("work");
    expect(managerProfileOf(config, "claude", "codex-work").id).toBe("claude-default");
  });
});

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
