import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import i18next from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import {
  agentStep,
  ChatEmptyState,
  ChatRequestDock,
  codexRateLimitOf,
  showsEmptyChat,
} from "../../../../../src/renderer/components/chat/chat-shell";
import type { QuickLookList } from "../../../../../src/renderer/components/chat/quick-look";
import { localChatLinks } from "../../../../../src/renderer/services/chat/local-chat-links";
import {
  type ChatModel,
  emptyModel,
  type PermissionRequest,
} from "../../../../../src/renderer/services/chat/model";
import type { AgentRow } from "../../../../../src/renderer/services/chat/panel";

const renderer = fileURLToPath(new URL("../../../../../src/renderer/", import.meta.url));
const screens = {
  claude: "components/chat/claude-tab.tsx",
  codex: "components/chat/codex-tab.tsx",
  remote: "components/agent-view/remote-pane.tsx",
};
const sourceOf = (file: string) => readFileSync(`${renderer}${file}`, "utf8");

const agent = (toolUseId: string): AgentRow => ({
  toolUseId,
  description: toolUseId,
  status: "running",
  toolCount: 0,
});

const request: PermissionRequest = {
  requestId: "r1",
  toolName: "Bash",
  input: { command: "ls" },
  suggestions: [],
};

function dock(model: ChatModel, onToMain?: () => void): string {
  return renderToStaticMarkup(
    <ChatRequestDock
      model={model}
      card={{ workspaceId: "w", cwd: "/w", rootPath: "/w", onAnswer: () => {} }}
      {...(onToMain ? { onToMain } : {})}
    />,
  );
}

describe("a permission request while a subagent is shown", () => {
  const waiting = { ...emptyModel(), permissions: [request] };

  test("the card shows at once and says it is the main conversation's", () => {
    const html = dock(waiting, () => {});
    expect(html).toContain('data-testid="chat-permission"');
    expect(html).toContain('data-testid="chat-permission-main"');
    expect(html).toContain(i18next.t("chat.strip.permission_waiting"));
    expect(html).toContain(i18next.t("chat.strip.to_main"));
  });

  test("on the main conversation the card has no such line", () => {
    const html = dock(waiting);
    expect(html).toContain('data-testid="chat-permission"');
    expect(html).not.toContain('data-testid="chat-permission-main"');
  });

  test("nothing waiting and nothing running: no dock", () => {
    expect(dock(emptyModel())).toBe("");
  });

  test("the three chat screens take the same dock and give it the way back", () => {
    for (const file of Object.values(screens)) {
      const source = sourceOf(file);
      expect(source).toContain("<ChatRequestDock");
      expect(source).toMatch(/onToMain: /);
      expect(source).not.toContain("<PermissionCard");
      expect(source).not.toContain("permission_waiting");
    }
  });
});

describe("stepping through the agents with ⌘[ and ⌘]", () => {
  const agents = [agent("a"), agent("b")];

  test("goes on from the main conversation and round again", () => {
    expect(agentStep(agents, null, "]")).toBe("a");
    expect(agentStep(agents, "a", "]")).toBe("b");
    expect(agentStep(agents, "b", "]")).toBeNull();
    expect(agentStep(agents, null, "[")).toBe("b");
  });

  test("takes no other key, and does nothing with no agents", () => {
    expect(agentStep(agents, null, "x")).toBeUndefined();
    expect(agentStep([], null, "]")).toBeUndefined();
  });

  test("all three chat screens have it, and the same shell", () => {
    for (const file of Object.values(screens)) {
      const source = sourceOf(file);
      expect(source).toContain("useShownAgent(");
      expect(source).toContain("onKeyDown={onKeyDown}");
      expect(source).toContain("<ChatShell");
      expect(source).toContain("useChatPanelPlace(");
    }
  });
});

describe("the empty conversation", () => {
  test("shows once the program is ready, or when the other computer does not say", () => {
    expect(showsEmptyChat("ready")).toBe(true);
    expect(showsEmptyChat("ended")).toBe(true);
    expect(showsEmptyChat(undefined)).toBe(true);
    for (const phase of ["idle", "starting", "held", "failed", "not-found"]) {
      expect(showsEmptyChat(phase)).toBe(false);
    }
  });

  test("the three chat screens keep to it", () => {
    for (const file of Object.values(screens)) {
      expect(sourceOf(file)).toContain("showsEmptyChat(");
    }
  });

  test("names the agent and the folder, and a resume that failed", () => {
    const html = renderToStaticMarkup(
      <ChatEmptyState agent="codex" cwd="/repo" error="gone" onDismissError={() => {}} />,
    );
    expect(html).toContain(i18next.t("chat.codex.empty"));
    expect(html).toContain("/repo");
    expect(html).toContain(i18next.t("chat.sessions.resume_failed", { message: "gone" }));
  });
});

describe("a Codex plan's limit", () => {
  const now = 1_000_000_000_000;
  test("reached and not yet reset: refused until it resets", () => {
    const resetsAt = now / 1000 + 600;
    expect(
      codexRateLimitOf(
        {
          primary: { usedPercent: 40, windowMins: 300 },
          secondary: { usedPercent: 100, windowMins: 10080, resetsAt },
        },
        now,
      ),
    ).toEqual({ status: "rejected", rateLimitType: "weekly", resetsAt });
  });

  test("under it, or past its reset: nothing to show", () => {
    expect(codexRateLimitOf({ primary: { usedPercent: 99 } }, now)).toBeUndefined();
    expect(
      codexRateLimitOf({ primary: { usedPercent: 100, resetsAt: now / 1000 - 1 } }, now),
    ).toBeUndefined();
    expect(codexRateLimitOf(undefined, now)).toBeUndefined();
  });
});

describe("a changed file opened from a local chat", () => {
  function links(root: string, outside: string[] = []) {
    const looked: string[] = [];
    const shown: (QuickLookList | null)[] = [];
    const made = localChatLinks({
      workspaceId: crypto.randomUUID(),
      tabId: "t",
      cwd: root,
      now: () => ({
        source: { items: [], tools: {}, agentItems: {} },
        rootPath: root,
        outside: { files: outside, dirs: [] },
        split: true,
      }),
      changesOf: (path) => ({ [path]: "before" }),
      opensAttached: () => false,
      look: (list) => shown.push(list),
      looked: (path) => looked.push(path),
    });
    return { made, looked, shown };
  }

  test("outside the workspace folder, the preview is let read it", () => {
    const { made, looked, shown } = links("/repo");
    made.openChange?.("/tmp/notes.md");
    expect(looked).toEqual(["/tmp/notes.md"]);
    expect(shown).toEqual([
      { files: ["/tmp/notes.md"], index: 0, changes: { "/tmp/notes.md": "before" } },
    ]);
  });

  test("inside it, or let already, nothing more is asked", () => {
    const inside = links("/repo");
    inside.made.openChange?.("/repo/src/a.ts");
    expect(inside.looked).toEqual([]);
    const granted = links("/repo", ["/tmp/notes.md"]);
    granted.made.openChange?.("/tmp/notes.md");
    expect(granted.looked).toEqual([]);
  });
});
