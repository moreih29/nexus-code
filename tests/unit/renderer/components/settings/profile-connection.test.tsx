import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProfileConnectionSection } from "../../../../../src/renderer/components/settings/panels/profile-connection-section";
import {
  type ProfileConnectionDraft,
  useProfileConnection,
} from "../../../../../src/renderer/components/settings/panels/use-profile-connection";
import type { AgentProfile } from "../../../../../src/shared/agent-profiles/profiles";
import type { ChatAgent } from "../../../../../src/shared/sessions/task-agent";

const profile: AgentProfile = {
  id: "claude-gateway",
  agent: "claude",
  name: "Gateway",
  color: "blue",
  dir: "",
  connection: {
    method: "custom",
    baseUrl: "https://gateway.example.com",
    defaultModel: "plain",
    models: [{ id: "plain" }, { id: "reasoning", reasoning: "high" }],
  },
};

function draftOf(agent: ChatAgent): ProfileConnectionDraft {
  let draft: ProfileConnectionDraft | undefined;
  function Capture() {
    draft = useProfileConnection(agent, profile);
    return null;
  }
  renderToStaticMarkup(<Capture />);
  if (!draft) throw new Error("the connection draft was not captured");
  return draft;
}

describe("custom profile reasoning controls", () => {
  test("keeps saved and blank values in the connection state", () => {
    const draft = draftOf("claude");

    expect(draft.rows.map(({ id, reasoning }) => ({ id, reasoning }))).toEqual([
      { id: "plain", reasoning: undefined },
      { id: "reasoning", reasoning: "high" },
    ]);
    expect(draft.connection).toMatchObject({
      method: "custom",
      models: [{ id: "plain" }, { id: "reasoning", reasoning: "high" }],
    });
  });

  test("shows a reasoning select for every Claude model row", () => {
    const html = renderToStaticMarkup(
      <ProfileConnectionSection agent="claude" draft={draftOf("claude")} />,
    );

    expect(html.match(/aria-label="Reasoning"/g)).toHaveLength(2);
    expect(html).toContain('<option value="none">None</option>');
    expect(html).toContain('<option value="high">low–high</option>');
    expect(html).toContain('<option value="xhigh">low–xhigh</option>');
  });
});
