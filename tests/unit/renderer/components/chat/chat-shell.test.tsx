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
import {
  localChatLinks,
  needsGrant,
  shownFile,
} from "../../../../../src/renderer/services/chat/local-chat-links";
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

  test("a request from a subagent does not say it is the main conversation's", () => {
    const html = dock({ ...emptyModel(), permissions: [{ ...request, agentId: "a1" }] }, () => {});
    expect(html).toContain('data-testid="chat-permission"');
    expect(html).not.toContain('data-testid="chat-permission-main"');
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
        outside: { files: outside, opened: [] },
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

  test("a card opened from an answer's gallery grants that one file, not the gallery", () => {
    const { made, looked, shown } = links("/repo");
    const gallery = ["/tmp/a.png", "/home/u/.ssh/id_rsa", "/repo/b.png"];
    made.openFile("/tmp/a.png", { gallery });
    expect(looked).toEqual(["/tmp/a.png"]);
    expect(shown).toEqual([{ files: gallery, index: 0 }]);
  });
});

describe("an image clicked among images the agent read", () => {
  const a = { mediaType: "image/png", data: "YQ==" };
  const b = { mediaType: "image/png", data: "Yg==" };
  const read = (id: string, file: string, image: typeof a) => ({
    id,
    name: "Read",
    status: "done",
    input: { file_path: file },
    result: { images: [image] },
  });
  const source = {
    items: [
      {
        kind: "assistant",
        blocks: [
          { type: "tool", toolUseId: "r1" },
          { type: "tool", toolUseId: "r2" },
        ],
      },
    ],
    tools: { r1: read("r1", "/net/h/s/a.png", a), r2: read("r2", "/net/h/s/b.png", b) },
    agentItems: {},
  } as never;

  test("opens the gallery and grants only the image on screen, never its neighbours", async () => {
    const looked: string[] = [];
    const shown: (QuickLookList | null)[] = [];
    const made = localChatLinks({
      workspaceId: crypto.randomUUID(),
      tabId: "t",
      cwd: "/repo",
      now: () => ({
        source,
        rootPath: "/repo",
        outside: { files: [], opened: [] },
        split: true,
      }),
      changesOf: () => undefined,
      opensAttached: () => false,
      look: (list) => shown.push(list),
      looked: (path) => looked.push(path),
    });
    made.openImages([a], 0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const list = shown.at(-1) ?? null;
    expect(list?.files).toEqual(["image:1", "image:2"]);
    expect(looked).toEqual([]);
    expect(shownFile(list)).toBe("/net/h/s/a.png");
    expect(list && shownFile({ ...list, index: 1 })).toBe("/net/h/s/b.png");
  });
});

describe("what a quick look shows is what the user looked at", () => {
  test("the file on screen, not an image held in the answer or a dropped draft", () => {
    expect(shownFile({ files: ["/tmp/a.png", "/tmp/b.png"], index: 1 })).toBe("/tmp/b.png");
    expect(shownFile(null)).toBeUndefined();
    expect(
      shownFile({ files: ["image:1"], index: 0, images: { "image:1": {} as never } }),
    ).toBeUndefined();
    expect(
      shownFile({
        files: ["image:1", "image:2"],
        index: 1,
        images: { "image:1": {} as never, "image:2": {} as never },
        paths: { "image:1": "/net/h/s/a.png", "image:2": "/net/h/s/b.png" },
      }),
    ).toBe("/net/h/s/b.png");
    expect(shownFile({ files: ["/tmp/a.png"], index: 0, draft: {} as File })).toBeUndefined();
  });

  test("asks a grant only for an absolute path outside the workspace not granted yet", () => {
    const outside = { files: ["/tmp/granted.png"], opened: ["/net/h/opened.png"] };
    expect(needsGrant("/tmp/new.png", "/repo", outside)).toBe(true);
    expect(needsGrant("D:/out/new.png", "C:/repo", outside)).toBe(true);
    expect(needsGrant("/tmp/granted.png", "/repo", outside)).toBe(false);
    expect(needsGrant("/net/h/opened.png", "/repo", outside)).toBe(false);
    expect(needsGrant("/net/h/new.png", "/repo", outside)).toBe(true);
    expect(needsGrant("/repo/src/a.ts", "/repo", outside)).toBe(false);
    expect(needsGrant("image:1", "/repo", outside)).toBe(false);
    expect(needsGrant("notes.md", "/repo", outside)).toBe(false);
  });
});
