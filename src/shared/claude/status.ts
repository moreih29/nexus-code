import { z } from "zod";

// ---------------------------------------------------------------------------
// Claude 세션 상태 enum
// ---------------------------------------------------------------------------

/**
 * Claude Code 세션의 6가지 실행 상태.
 *
 * - idle            : 세션 미시작 또는 사용자가 completed를 확인한 후 — 조용한 기본 상태.
 * - running         : SessionStart / UserPromptSubmit / PreToolUse 진행 중.
 * - completed       : Stop hook 직후 — 응답이 끝나 사용자가 확인해야 함을 표시. 다음
 *                     SessionStart/UserPromptSubmit/PreToolUse로 자동 running 전이되거나,
 *                     사용자가 해당 탭을 활성화하면 (markSeen IPC) idle로 전이된다.
 * - needsInput      : Notification hook 수신 — 일반 사용자 입력 대기 (60s idle 등).
 * - permissionPending: PermissionRequest hook 진행 중 — 사용자 결정 대기 (sync).
 * - error           : Claude Code 비정상 종료 또는 hook 처리 실패.
 */
export const ClaudeStatusSchema = z.enum([
  "idle",
  "running",
  "completed",
  "needsInput",
  "permissionPending",
  "error",
]);

export type ClaudeStatus = z.infer<typeof ClaudeStatusSchema>;

// ---------------------------------------------------------------------------
// StatusEntry — 워크스페이스·탭 단위 상태 페이로드
// ---------------------------------------------------------------------------

/**
 * 특정 (workspaceId, tabId) 쌍의 현재 Claude 세션 상태를 나타내는 페이로드.
 *
 * since 는 상태가 마지막으로 변경된 시각을 Date.now() ms 단위로 기록한다.
 * main → renderer broadcast 및 snapshot 응답에서 공통으로 사용된다.
 */
export const StatusEntrySchema = z.object({
  workspaceId: z.string().min(1),
  tabId: z.string().min(1),
  status: ClaudeStatusSchema,
  message: z.string().optional(),
  since: z.number().int().positive(),
});

export type StatusEntry = z.infer<typeof StatusEntrySchema>;

// ---------------------------------------------------------------------------
// HookRequest — agent→main NDJSON hook 요청 (IPC contract에는 등록하지 않음)
// ---------------------------------------------------------------------------

/**
 * Go agent의 hookserver 가 main 으로 전달하는 hook 요청 프레임.
 *
 * hookId는 agent가 발급한 UUID로, main이 respondHook을 통해 응답을 돌려줄 때
 * 어느 in-flight 연결에 응답할지 식별하는 correlationId 역할을 한다.
 *
 * payload는 Claude Code가 hook 프로세스 stdin에 쓴 원본 JSON을 그대로 담는다.
 * subcommand별 payload 구조가 다르므로 z.unknown()으로 받아 각 handler에서 구체화한다.
 *
 * assistantText는 Stop hook subcommand에서만 채워지는 옵션 필드다. hookclient가
 * payload의 transcript_path를 직접 읽어 마지막 assistant 메시지 텍스트를 단일
 * 줄로 정규화 + truncate한 값. transcript가 없거나 파싱 실패 시 undefined.
 * Hook 실행 호스트(로컬 또는 SSH 원격)와 transcript_path가 동일 fs이므로 main이
 * 호스트별 fs 라우팅을 알 필요 없다.
 */
export const HookRequestSchema = z.object({
  hookId: z.string().min(1),
  workspaceId: z.string().min(1),
  tabId: z.string().min(1),
  subcommand: z.string().min(1),
  payload: z.unknown(),
  assistantText: z.string().optional(),
});

export type HookRequest = z.infer<typeof HookRequestSchema>;

// ---------------------------------------------------------------------------
// HookResponse — main→agent 응답 (hook 프로세스 stdout 으로 write)
// ---------------------------------------------------------------------------

/**
 * main이 agent에게 돌려주는 hook 응답.
 *
 * stdout이 있으면 hook 프로세스가 그 내용을 stdout에 write 후 exit한다.
 * exitCode 를 지정하지 않으면 agent는 0으로 처리한다.
 */
export const HookResponseSchema = z.object({
  stdout: z.string().optional(),
  exitCode: z.number().int().optional(),
});

export type HookResponse = z.infer<typeof HookResponseSchema>;
