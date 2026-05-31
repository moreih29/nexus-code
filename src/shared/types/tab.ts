import { z } from "zod";
import { WorkspaceIdSchema } from "./workspace-id";

const TabIdSchema = z.string().uuid();

const TabBaseSchema = z.object({
  id: TabIdSchema,
  workspaceId: WorkspaceIdSchema,
  /**
   * 표시용 타이틀 — derived value: customTitle ?? processTitle ?? defaultTitle.
   * persistence 호환을 위해 직렬화 시 함께 저장된다. 복원 시 store가 동일 규칙으로
   * 재계산하므로 직렬화된 값은 단순 캐시 역할.
   */
  title: z.string(),
  /**
   * 탭 생성 시점에 결정되는 기본 타이틀. customTitle / processTitle 둘 다 비어있을
   * 때 fallback. 영구 보관 (사용자가 rename clear 시 이 값으로 복귀).
   */
  defaultTitle: z.string().optional(),
  /**
   * 사용자가 수동으로 지정한 타이틀. 설정되면 processTitle을 무시하고 title을 고정.
   * 빈 문자열 입력 시 clear되어 자동(processTitle/defaultTitle)으로 복귀.
   */
  customTitle: z.string().optional(),
  /**
   * 자동 감지된 타이틀. 터미널은 OSC 0/1/2 (xterm.js onTitleChange), 브라우저는
   * page-title-updated 이벤트로 갱신. customTitle이 있으면 표시에는 영향 없음.
   */
  processTitle: z.string().optional(),
  isPreview: z.boolean().optional(),
});

export const DiffTabPayloadSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  relPath: z.string().min(1),
  leftRef: z.string().min(1),
  rightRef: z.string().min(1),
  oldRelPath: z.string().min(1).optional(),
});
export type DiffTabPayload = z.infer<typeof DiffTabPayloadSchema>;

export const GitCommitTabPayloadSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  sha: z.string().min(1),
});
export type GitCommitTabPayload = z.infer<typeof GitCommitTabPayloadSchema>;

/**
 * BrowserTab payload — fully persisted. `partition` follows the
 * `persist:browser-${workspaceId}` convention; the caller is responsible
 * for constructing the correct value before creating a tab.
 */
export const BrowserTabPayloadSchema = z.object({
  initialUrl: z.string(),
  lastUrl: z.string(),
  partition: z.string(),
});
export type BrowserTabPayload = z.infer<typeof BrowserTabPayloadSchema>;

export const TabMetaSchema = z.discriminatedUnion("type", [
  TabBaseSchema.extend({
    type: z.literal("terminal"),
    cwd: z.string(),
  }),
  TabBaseSchema.extend({
    type: z.literal("agent"),
    cwd: z.string(),
    agentKind: z.enum(["claude-code", "codex", "custom"]).optional(),
  }),
  TabBaseSchema.extend({
    type: z.literal("editor"),
    cwd: z.string().optional(),
    filePath: z.string(),
  }),
  DiffTabPayloadSchema.extend({
    id: TabIdSchema,
    type: z.literal("editor.diff"),
    title: z.string(),
    defaultTitle: z.string().optional(),
    customTitle: z.string().optional(),
    processTitle: z.string().optional(),
    isPreview: z.boolean().optional(),
  }),
  GitCommitTabPayloadSchema.extend({
    id: TabIdSchema,
    type: z.literal("git.commit"),
    title: z.string(),
    defaultTitle: z.string().optional(),
    customTitle: z.string().optional(),
    processTitle: z.string().optional(),
    isPreview: z.boolean().optional(),
  }),
]);

export type TabMeta = z.infer<typeof TabMetaSchema>;
