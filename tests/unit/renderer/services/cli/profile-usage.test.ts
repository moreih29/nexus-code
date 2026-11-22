import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { ChatController } from "../../../../../src/renderer/services/chat/claude/controller";
import { CodexController } from "../../../../../src/renderer/services/chat/codex/controller";
import {
  ingestClaudeUsage,
  ingestCodexLimits,
  ingestCodexPush,
  planUsageKey,
  usePlanUsageStore,
} from "../../../../../src/renderer/services/chat/plan-usage";
import { chatHandlers } from "../../../../../src/renderer/services/cli/chat-actions";
import { useAgentProfilesStore } from "../../../../../src/renderer/state/stores/agent-profiles";
import { useWorkspacesStore } from "../../../../../src/renderer/state/stores/workspaces";
import { WorkspaceMetaSchema } from "../../../../../src/shared/types/workspace";

const local = WorkspaceMetaSchema.parse({
  id: "11111111-1111-4111-8111-111111111111",
  name: "Local",
  rootPath: "/repo",
  pinned: false,
  tabs: [],
});
const remote = WorkspaceMetaSchema.parse({
  id: "22222222-2222-4222-8222-222222222222",
  name: "Remote",
  rootPath: "/repo",
  pinned: false,
  tabs: [],
  location: { kind: "ssh", host: "box", remotePath: "/repo" },
});
const claudeUsage = (percent: number, resetsAt: number) => ({
  rate_limits: {
    limits: [{ kind: "session", percent, resets_at: new Date(resetsAt).toISOString() }],
  },
});
const read = chatHandlers["chat.usage"];

let restore: () => void;
beforeEach(() => {
  const { config } = useAgentProfilesStore.getState();
  const { workspaces } = useWorkspacesStore.getState();
  const { byKey } = usePlanUsageStore.getState();
  restore = () => {
    useAgentProfilesStore.setState({ config });
    useWorkspacesStore.setState({ workspaces });
    usePlanUsageStore.setState({ byKey });
  };
  useWorkspacesStore.setState({ workspaces: [local, remote] });
  usePlanUsageStore.setState({ byKey: {} });
  useAgentProfilesStore.getState().hydrate({
    profiles: [
      { id: "personal", name: "개인", agent: "claude", color: "blue", dir: "~/.claude-personal" },
      {
        id: "key",
        name: "Key",
        agent: "codex",
        color: "cyan",
        dir: "~/.codex-key",
        connection: { method: "api-key" },
      },
      {
        id: "local-api",
        name: "Local API",
        agent: "claude",
        color: "blue",
        dir: "~/.claude-api",
        connection: {
          method: "custom",
          baseUrl: "http://localhost:8888",
          auth: "bearer",
          models: [{ id: "model" }],
          defaultModel: "model",
        },
      },
    ],
    rules: [],
    defaults: {},
  });
});
afterEach(() => restore());

test("classifies usage by host, age, reset and connection method without a tab", async () => {
  const now = Date.now();
  const expired = now - 1_000;
  const old = now - 180_000;
  const future = now + 3_600_000;
  ingestClaudeUsage(
    planUsageKey("claude", local.location, "personal"),
    claudeUsage(18, expired),
    now,
  );
  ingestClaudeUsage(
    planUsageKey("claude", remote.location, "personal"),
    claudeUsage(5, future),
    now,
  );
  ingestClaudeUsage(
    planUsageKey("claude", local.location, "local-api"),
    claudeUsage(9, future),
    now,
  );
  const codex = planUsageKey("codex", undefined, undefined);
  ingestCodexLimits(codex, { secondary: { usedPercent: 25, windowMins: 10_080 } }, old);
  ingestCodexPush(codex, { primary: { usedPercent: 8, windowDurationMins: 300 } }, now);

  const { profiles } = await read({});
  expect(profiles.map(({ id, status }) => [id, status])).toEqual([
    ["claude-default", "unavailable"],
    ["personal", "stale"],
    ["local-api", "not-subscription"],
    ["codex-default", "stale"],
    ["key", "not-subscription"],
  ]);
  expect(profiles.find(({ id }) => id === "local-api")?.limits).toEqual([]);
  expect(profiles.find(({ id }) => id === "personal")?.limits).toEqual([
    { kind: "session", percent: 18, fetchedAt: now, resetsAt: expired, stale: true },
  ]);
  expect(profiles.find(({ id }) => id === "codex-default")?.limits).toEqual([
    { kind: "window", windowMins: 300, percent: 8, fetchedAt: now, stale: false },
    { kind: "weekly", percent: 25, fetchedAt: old, stale: true },
  ]);
  const ssh = await read({ workspaceId: remote.id, agent: "claude", profile: "개인" });
  expect(ssh.profiles).toEqual([
    {
      id: "personal",
      name: "개인",
      agent: "claude",
      status: "fresh",
      fetchedAt: now,
      limits: [{ kind: "session", percent: 5, fetchedAt: now, resetsAt: future, stale: false }],
    },
  ]);
  await expect(read({ profile: "default" })).rejects.toThrow("more than one profile matches");
});

test("explicit refresh probes the selected account once and skips other connections", async () => {
  const claude = spyOn(ChatController, "probePlanUsage").mockResolvedValue(
    claudeUsage(30, Date.now() + 3_600_000),
  );
  const codex = spyOn(CodexController, "probePlanUsage").mockResolvedValue({});
  try {
    const request = { agent: "claude", profile: "PERSONAL", refresh: true } as const;
    const [a, b] = await Promise.all([read(request), read(request)]);
    expect(a).toEqual(b);
    expect(a.profiles[0]?.limits[0]?.percent).toBe(30);
    expect(claude).toHaveBeenCalledTimes(1);
    expect(claude).toHaveBeenCalledWith({
      workspaceId: local.id,
      cwd: local.rootPath,
      profileId: "personal",
    });
    expect((await read({ profile: "local-api", refresh: true })).profiles[0]?.status).toBe(
      "not-subscription",
    );
    expect((await read({ profile: "key", refresh: true })).profiles[0]?.status).toBe(
      "not-subscription",
    );
    expect(claude).toHaveBeenCalledTimes(1);
    expect(codex).not.toHaveBeenCalled();
  } finally {
    claude.mockRestore();
    codex.mockRestore();
  }
});
