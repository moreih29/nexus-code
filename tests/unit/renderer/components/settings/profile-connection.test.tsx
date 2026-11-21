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

function draftOf(agent: ChatAgent, source: AgentProfile = profile): ProfileConnectionDraft {
  let draft: ProfileConnectionDraft | undefined;
  function Capture() {
    draft = useProfileConnection(agent, source);
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

    expect(html.match(/aria-label="Max effort"/g)).toHaveLength(2);
    expect(html).toContain("grid-cols-[minmax(0,1fr)_minmax(0,1fr)_7rem_3rem_1.5rem]");
    expect(html).toContain('<option value="auto">Auto</option>');
    expect(html).toContain('<option value="none">Unsupported</option>');
    expect(html).toContain('<option value="high">high</option>');
    expect(html).toContain('<option value="xhigh">xhigh</option>');
    expect(html).toContain('<option value="max">max</option>');
  });

  test("gives Codex reasoning options the same readable column width", () => {
    const html = renderToStaticMarkup(
      <ProfileConnectionSection agent="codex" draft={draftOf("codex")} />,
    );

    expect(html).toContain("grid-cols-[minmax(0,1fr)_minmax(0,1fr)_5.5rem_7rem_3rem_1.5rem]");
    expect(html).toContain('<option value="xhigh">xhigh</option>');
  });

  test("explains the effort column as the chat menu limit per agent", () => {
    const claude = renderToStaticMarkup(
      <ProfileConnectionSection agent="claude" draft={draftOf("claude")} />,
    );
    expect(claude).toContain("Upper limit of the chat effort menu · Auto keeps Claude Code");
    const codex = renderToStaticMarkup(
      <ProfileConnectionSection agent="codex" draft={draftOf("codex")} />,
    );
    expect(codex).toContain("Upper limit of the chat effort menu<");
    expect(codex).not.toContain("Auto keeps");
  });

  test("rejects an unrepresentable Claude reasoning ID in the dialog, not at launch", () => {
    const reserved: AgentProfile = {
      ...profile,
      connection: {
        method: "custom",
        baseUrl: "https://gateway.example.com",
        defaultModel: "model;other",
        models: [{ id: "model;other", reasoning: "none" }],
      },
    };
    const draft = draftOf("claude", reserved);
    expect(draft.reasoningModelIdError).toBe(true);
    expect(draft.valid).toBe(false);
    const html = renderToStaticMarkup(<ProfileConnectionSection agent="claude" draft={draft} />);
    expect(html).toContain("To choose a max effort");
    expect(html).not.toContain("`");

    const automatic = draftOf("claude", {
      ...reserved,
      connection: { ...reserved.connection, models: [{ id: "model;other" }] },
    });
    expect(automatic.reasoningModelIdError).toBe(false);
    expect(automatic.valid).toBe(true);

    const codex = draftOf("codex", { ...reserved, agent: "codex" });
    expect(codex.reasoningModelIdError).toBe(false);
    expect(codex.valid).toBe(true);
  });
});
