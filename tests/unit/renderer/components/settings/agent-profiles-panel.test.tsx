import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentProfile } from "../../../../../src/shared/agent-profiles/profiles";
import type { AgentProfileStatus } from "../../../../../src/shared/agent-profiles/status";

const { ProfileRow } = await import(
  "../../../../../src/renderer/components/settings/panels/agent-profiles-panel"
);

const WORK: AgentProfile = {
  id: "claude-work",
  agent: "claude",
  name: "Work",
  color: "blue",
  dir: "~/.claude-work",
};

function row(status: AgentProfileStatus): string {
  return renderToStaticMarkup(
    <ProfileRow
      agent="claude"
      profile={WORK}
      profiles={[WORK]}
      statuses={{ [WORK.id]: { status, loading: false } }}
      onRefresh={() => {}}
      onEdit={() => {}}
      onRemove={() => {}}
      onLogin={() => {}}
      onLoginAgain={() => {}}
    />,
  );
}

/** The button the label names, as the markup has it. */
function button(html: string, label: string): string | undefined {
  return html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0];
}

describe("ProfileRow", () => {
  test("lets a signed-in profile sign in again, to another account or organization", () => {
    const html = row({ state: "signed-in", orgId: "org-a", orgName: "Acme", plan: "team" });

    const again = button(html, "Sign Work in again");
    expect(again).toBeDefined();
    expect(again).not.toContain(' disabled=""');
    expect(again).toContain('title="Sign in again, to another account or organization"');
  });

  test("keeps a signed-out profile to its own sign-in button", () => {
    const html = row({ state: "signed-out" });

    expect(html).toContain(">Sign in</button>");
    // Its place stays, hidden, so the rows' buttons line up.
    const again = button(html, "Sign Work in again");
    expect(again).toContain(' disabled=""');
    expect(again).toContain(" invisible");
  });
});
