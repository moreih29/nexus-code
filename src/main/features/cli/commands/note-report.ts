import {
  MAX_REPORT_CHARS,
  type NoteConversation,
  NoteReportPrSchema,
} from "../../../../shared/notes/links";
import { NOTE_ID_RE } from "../../../../shared/notes/types";
import { CliUsageError } from "../args";
import { CliError, type CliNotes, pick } from "../context";
import { type CliCommand, output } from "../registry";

type ReportTarget = Awaited<ReturnType<CliNotes["reportTargets"]>>[number];

function selectNote(targets: ReportTarget[], positionals: string[]) {
  const selector = positionals[0];
  if (!selector || positionals.length < 2) return targets;
  const lower = selector.toLowerCase();
  const notes = Array.from(new Map(targets.map((target) => [target.noteId, target])).values());
  if (
    !NOTE_ID_RE.test(lower) &&
    !notes.some(
      ({ noteId, title }) =>
        noteId === lower ||
        (lower.length >= 4 && noteId.startsWith(lower)) ||
        title.toLowerCase() === lower,
    )
  )
    return targets;
  const note = pick(
    notes,
    selector,
    (item) => item.noteId,
    (item) => item.title,
    "linked note",
  );
  positionals.shift();
  return targets.filter(({ noteId }) => noteId === note.noteId);
}

function reportPr(value: string) {
  const parsed = NoteReportPrSchema.shape.url.safeParse(value);
  if (!parsed.success || !/^https?:\/\//i.test(value) || /[\p{Cc}\s]/u.test(value)) {
    throw new CliUsageError("--pr needs an http or https URL");
  }
  const url = new URL(parsed.data);
  if (!NoteReportPrSchema.shape.url.safeParse(url.href).success) {
    throw new CliUsageError("--pr URL is too long");
  }
  const match = /(?:^|\/)(?:pull|pulls|pullrequest|merge_requests)\/(\d+)(?:\/|$)/i.exec(
    url.pathname,
  );
  const number = Number(match?.[1]);
  return { url: url.href, ...(Number.isSafeInteger(number) && number > 0 ? { number } : {}) };
}

export const noteReport: CliCommand = {
  path: ["note", "report"],
  summary: "Save a result on a to-do linked to this conversation",
  args: "[<note>] <text...>",
  details:
    "Only a verified Claude or Codex tab can report to its linked to-dos.\n" +
    "With several linked to-dos, name the note or use --line with its link id.\n" +
    "The report is at most 500 characters of plain text. With no status flag it records a completed result.",
  flags: {
    done: { type: "boolean", description: "Mark the result done and check the to-do" },
    failed: { type: "boolean", description: "Record a failed result" },
    pr: { type: "string", value: "URL", description: "Link the result to a pull request" },
    line: {
      type: "string",
      value: "ID",
      description: "Select one of this conversation's to-do links",
    },
  },
  async run(ctx, { flags, positionals }) {
    const { workspaceId, tabId, verified } = ctx.caller;
    if (verified !== true) throw new CliError("note report requires a verified conversation tab");
    if (flags.done === true && flags.failed === true) {
      throw new CliUsageError("choose either --done or --failed");
    }
    const { tabs } = await ctx.services.ui("tabs.list", { workspaceId, includeSession: true });
    const caller = tabs.find(({ id }) => id === tabId);
    if (caller?.type !== "claude" && caller?.type !== "codex") {
      throw new CliError("note report requires a Claude or Codex tab");
    }
    const tab: NoteConversation = {
      workspaceId,
      tabId,
      agent: caller.type,
      session: caller.session,
    };
    const targets = await ctx.services.notes.reportTargets(tab);
    if (!targets.length) throw new CliError("No linked to-do for this conversation");
    const text = [...positionals];
    const eligible = selectNote(targets, text);
    const selection =
      typeof flags.line === "string"
        ? pick(
            eligible,
            flags.line,
            ({ linkId }) => linkId,
            ({ linkId }) => linkId,
            "linked to-do",
          )
        : eligible.length === 1
          ? eligible[0]
          : undefined;
    if (!selection) {
      throw new CliError(
        "More than one linked to-do · name the note or pass --line\n" +
          eligible.map(({ noteId, linkId }) => `  ${noteId} · --line ${linkId}`).join("\n"),
      );
    }

    const input = text.join(" ").trim();
    if (Array.from(input).length > MAX_REPORT_CHARS) {
      throw new CliUsageError(`report text must be at most ${MAX_REPORT_CHARS} characters`);
    }
    const summary = input.replace(/[\s\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim();
    if (!summary) throw new CliUsageError("missing <text>");
    if (/!\[|<\/?[a-z][a-z0-9:-]*(?:\s|\/?>)|<!|<\?/i.test(summary)) {
      throw new CliUsageError("report text cannot contain images or HTML");
    }
    const pr = typeof flags.pr === "string" ? reportPr(flags.pr) : undefined;
    const { noteId, linkId } = selection;
    const result = {
      state: flags.failed === true ? ("failed" as const) : ("done" as const),
      summary,
      ...(pr ? { pr } : {}),
      at: ctx.services.clock.now(),
    };
    const updated = await ctx.services.notes.reportLine(tab, noteId, {
      linkId,
      check: flags.done === true,
      result,
    });
    return output(updated ? "Reported to the linked to-do." : "Saved the linked to-do's result.", {
      noteId,
      linkId,
      updated,
      result,
    });
  },
};
