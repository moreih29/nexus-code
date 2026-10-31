/**
 * What the nexus CLI asks of the renderer, which owns the tabs, the layout
 * and the terminals' screens. Main sends "cli.uiRequest" to the active
 * window and the renderer answers with "cli.uiRespond".
 */
import { z } from "zod";

/** One tab as the CLI lists it. */
export interface CliTabInfo {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  /** The group (editor split) the tab is in. */
  readonly groupId: string;
  /** Whether it is the tab its group shows. */
  readonly shown: boolean;
  /** A terminal's starting directory. */
  readonly cwd?: string;
  /** An editor's file. */
  readonly filePath?: string;
  /** A browser tab's page. */
  readonly url?: string;
  /** A terminal whose process has ended. */
  readonly dead?: boolean;
}

/** The operations, with what each takes and gives. */
export interface CliUiOps {
  /** The tabs of a workspace, in layout order. */
  "tabs.list": {
    args: { workspaceId: string };
    result: { tabs: CliTabInfo[] };
  };
  /** The text of a terminal: its last `lines` lines, scrollback included. */
  "terminal.read": {
    args: { workspaceId: string; tabId: string; lines: number };
    result: { text: string };
  };
}

export type CliUiOp = keyof CliUiOps;

export const CliUiRequestSchema = z.object({
  requestId: z.string().min(1),
  op: z.string().min(1),
  args: z.unknown(),
});
export type CliUiRequest = z.infer<typeof CliUiRequestSchema>;

export const CliUiRespondArgsSchema = z.object({
  requestId: z.string().min(1),
  ok: z.boolean(),
  value: z.unknown().optional(),
  error: z.string().optional(),
});
export type CliUiRespondArgs = z.infer<typeof CliUiRespondArgsSchema>;
