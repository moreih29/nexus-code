import { describe, expect, test } from "bun:test";
import {
  INSTRUCTION_LIMIT,
  InstructionTextSchema,
  mergeAgentInstructions,
} from "../../../src/shared/chat/instructions";

const target = {
  agent: "claude" as const,
  profile: { id: "profile", name: "Personal" },
  workspace: { id: "workspace", name: "Nexus" },
};

describe("agent instruction layers", () => {
  test("omits blank layers and the whole header when no layers have content", () => {
    expect(
      mergeAgentInstructions(
        { all: " \n ", codex: "not for Claude" },
        { ...target, session: "\t" },
      ),
    ).toBe("");
    expect(mergeAgentInstructions({ all: "shared" }, target)).toEndWith("## All agents\nshared");
  });

  test("merges the applicable layers from general to specific", () => {
    const text = mergeAgentInstructions(
      {
        all: "shared",
        claude: "Claude rules",
        codex: "Codex rules",
        profiles: { profile: "profile rules" },
        workspaces: { workspace: "workspace rules" },
      },
      { ...target, session: "  session rules\n" },
    );
    expect(text).toBe(
      "# Instructions set in NexusCode\nFrom general to specific. If two conflict, follow the later one.\n\n" +
        "## All agents\nshared\n\n## Claude\nClaude rules\n\n## Profile: Personal\nprofile rules\n\n" +
        "## Workspace: Nexus\nworkspace rules\n\n## This session\nsession rules",
    );
    expect(
      mergeAgentInstructions({ claude: "Claude rules", codex: "Codex rules" }, { agent: "codex" }),
    ).toEndWith("## Codex\nCodex rules");
  });

  test("caps each layer", () => {
    expect(InstructionTextSchema.safeParse("a".repeat(INSTRUCTION_LIMIT)).success).toBe(true);
    expect(InstructionTextSchema.safeParse("a".repeat(INSTRUCTION_LIMIT + 1)).success).toBe(false);
  });
});
