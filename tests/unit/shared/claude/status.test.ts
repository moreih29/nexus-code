/** Contract: ClaudeStatusSchema, StatusEntrySchema round-trip validation */
import { describe, expect, it } from "bun:test";
import {
  ClaudeStatusSchema,
  HookRequestSchema,
  HookResponseSchema,
  StatusEntrySchema,
} from "../../../../src/shared/claude/status";

// ---------------------------------------------------------------------------
// ClaudeStatusSchema — 5-상태 enum round-trip
// ---------------------------------------------------------------------------

describe("ClaudeStatusSchema", () => {
  const validStatuses = ["idle", "running", "needsInput", "permissionPending", "error"] as const;

  it.each(validStatuses)("round-trip parses '%s'", (status) => {
    const result = ClaudeStatusSchema.safeParse(status);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe(status);
    }
  });

  it("rejects an unknown status string", () => {
    expect(ClaudeStatusSchema.safeParse("unknown").success).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(ClaudeStatusSchema.safeParse("").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// StatusEntrySchema — since 양의 정수 + 빈 문자열 거부
// ---------------------------------------------------------------------------

const VALID_ENTRY = {
  workspaceId: "ws-abc",
  tabId: "tab-xyz",
  status: "running",
  since: Date.now(),
} as const;

describe("StatusEntrySchema", () => {
  it("accepts a valid entry without message", () => {
    expect(StatusEntrySchema.safeParse(VALID_ENTRY).success).toBe(true);
  });

  it("accepts a valid entry with optional message", () => {
    const result = StatusEntrySchema.safeParse({ ...VALID_ENTRY, message: "waiting…" });
    expect(result.success).toBe(true);
  });

  it("rejects when since is negative", () => {
    const result = StatusEntrySchema.safeParse({ ...VALID_ENTRY, since: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects when since is zero", () => {
    const result = StatusEntrySchema.safeParse({ ...VALID_ENTRY, since: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects when since is a non-integer", () => {
    const result = StatusEntrySchema.safeParse({ ...VALID_ENTRY, since: 1234.5 });
    expect(result.success).toBe(false);
  });

  it("rejects an empty workspaceId", () => {
    const result = StatusEntrySchema.safeParse({ ...VALID_ENTRY, workspaceId: "" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty tabId", () => {
    const result = StatusEntrySchema.safeParse({ ...VALID_ENTRY, tabId: "" });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid status value", () => {
    const result = StatusEntrySchema.safeParse({ ...VALID_ENTRY, status: "paused" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HookRequestSchema — 기본 구조 검증
// ---------------------------------------------------------------------------

describe("HookRequestSchema", () => {
  const VALID_HOOK = {
    hookId: "hook-1",
    workspaceId: "ws-1",
    tabId: "tab-1",
    subcommand: "notification",
    payload: { message: "hello" },
  };

  it("accepts a valid hook request", () => {
    expect(HookRequestSchema.safeParse(VALID_HOOK).success).toBe(true);
  });

  it("accepts null payload (unknown type)", () => {
    expect(HookRequestSchema.safeParse({ ...VALID_HOOK, payload: null }).success).toBe(true);
  });

  it("rejects an empty hookId", () => {
    expect(HookRequestSchema.safeParse({ ...VALID_HOOK, hookId: "" }).success).toBe(false);
  });

  it("rejects an empty subcommand", () => {
    expect(HookRequestSchema.safeParse({ ...VALID_HOOK, subcommand: "" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HookResponseSchema — stdout/exitCode 선택적 필드
// ---------------------------------------------------------------------------

describe("HookResponseSchema", () => {
  it("accepts an empty response object", () => {
    expect(HookResponseSchema.safeParse({}).success).toBe(true);
  });

  it("accepts stdout-only response", () => {
    expect(HookResponseSchema.safeParse({ stdout: '{"permissionDecision":"allow"}' }).success).toBe(
      true,
    );
  });

  it("accepts exitCode-only response", () => {
    expect(HookResponseSchema.safeParse({ exitCode: 0 }).success).toBe(true);
  });

  it("rejects a non-integer exitCode", () => {
    expect(HookResponseSchema.safeParse({ exitCode: 1.5 }).success).toBe(false);
  });
});
