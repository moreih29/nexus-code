import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentProfile } from "../../../../../src/shared/agent-profiles/profiles";
import type { AgentProfileStatus } from "../../../../../src/shared/agent-profiles/status";
import type { ChatAgent } from "../../../../../src/shared/sessions/task-agent";

const { ProfileStatusText } = await import(
  "../../../../../src/renderer/components/settings/panels/agent-profiles-panel"
);

const profile: AgentProfile = { id: "work", agent: "claude", name: "Work", dir: "~/.claude-work" };

function render(status: AgentProfileStatus, agent: ChatAgent = "claude"): string {
  return renderToStaticMarkup(
    <ProfileStatusText
      agent={agent}
      profile={{ ...profile, agent }}
      profiles={[{ ...profile, agent }]}
      statuses={{ work: { status, loading: false } }}
      onLogin={() => {}}
    />,
  );
}

describe("a profile row whose sign-in can't be read", () => {
  test("says the program is not found only when it is not on the PATH", () => {
    const html = render({
      state: "unavailable",
      message: "claude was not found on the PATH",
      reason: "missing",
    });

    expect(html).toContain("claude not found");
    expect(html).toContain('title="claude was not found on the PATH"');
  });

  test("names the command that gave no answer, keeping its message in the tooltip", () => {
    const html = render({
      state: "unavailable",
      message: "claude auth status gave no answer",
      reason: "no-answer",
    });

    expect(html).toContain("No answer from claude auth status");
    expect(html).not.toContain("not found");
    expect(html).toContain('title="claude auth status gave no answer"');
  });

  test("says the sign-in could not be checked when it failed for another reason", () => {
    const html = render({ state: "unavailable", message: "profile codex-work is gone" }, "codex");

    expect(html).toContain("Could not check the sign-in");
    expect(html).not.toContain("not found");
    expect(html).toContain('title="profile codex-work is gone"');
  });
});
