// What the user told Claude when it asked: its questions with the answers
// picked, and its plan with how it went. They stand in the conversation
// once the card that asked is gone.

import {
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  ListTodo,
  LoaderCircle,
  MessageCircleQuestion,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ToolCall } from "../../services/chat/model";
import { cn } from "../../utils/cn";
import { ChatMarkdown } from "./chat-markdown";
import { readQuestions } from "./permission-card";

/** The tools whose calls ask the user, which these rows show. */
export const PROMPT_TOOLS: ReadonlySet<string> = new Set(["AskUserQuestion", "ExitPlanMode"]);

/**
 * Whether a call the user was asked about ended as they said: not in the
 * tool's own error, which a generic row shows. A no read back from the
 * transcript is an error too, though one in the user's words.
 */
export function showsAsPrompt(tool: ToolCall | undefined): tool is ToolCall {
  if (!tool || !PROMPT_TOOLS.has(tool.name)) return false;
  return tool.status !== "error" || !(tool.result?.text ?? "").includes("<tool_use_error>");
}

/** What the user said with a no, without what the CLI added to it. */
export function declineReason(tool: ToolCall): string {
  return (tool.result?.text ?? "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .trim();
}

/** The answers the user gave, by question, as the CLI kept them. */
export function answersOf(tool: ToolCall): Record<string, string> {
  const structured = tool.result?.structured as { answers?: unknown } | null | undefined;
  const answers = structured?.answers;
  const out: Record<string, string> = {};
  if (typeof answers === "object" && answers !== null) {
    for (const [question, answer] of Object.entries(answers)) {
      if (typeof answer === "string") out[question] = answer;
      else if (Array.isArray(answer)) out[question] = answer.join(", ");
    }
    return out;
  }
  // Without them, the answer's text: `"question"="answer", …`.
  for (const match of (tool.result?.text ?? "").matchAll(/"([^"]*)"="([^"]*)"/g)) {
    out[match[1] ?? ""] = match[2] ?? "";
  }
  return out;
}

function isPending(tool: ToolCall): boolean {
  return tool.status === "running" || tool.status === "streaming";
}

function isDeclined(tool: ToolCall): boolean {
  return tool.status === "denied" || tool.status === "error";
}

/** One line for a prompt that has no answer to show: still asked, stopped or turned down. */
function PromptLine({
  tool,
  icon,
  label,
  detail,
}: {
  tool: ToolCall;
  icon: React.ReactNode;
  label: string;
  detail: string;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="my-1 flex min-w-0 items-center gap-1.5 px-1.5 py-1 text-app-ui-sm"
      data-tool-use-id={tool.id}
    >
      {isPending(tool) ? (
        <LoaderCircle className="size-3.5 shrink-0 animate-spin text-[var(--state-loading-indicator)]" />
      ) : tool.status === "stopped" ? (
        <CircleStop className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        icon
      )}
      <span className="shrink-0 font-medium text-foreground">{label}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground" title={detail}>
        {detail}
      </span>
      {tool.status === "stopped" && (
        <span className="shrink-0 text-muted-foreground">{t("chat.tool.stopped")}</span>
      )}
    </div>
  );
}

/** Claude's questions and the answers the user picked. */
export function AnsweredQuestions({ tool }: { tool: ToolCall }) {
  const { t } = useTranslation();
  const questions = readQuestions((tool.input ?? {}) as Record<string, unknown>);
  const first = questions[0]?.question ?? "";
  if (isPending(tool) || tool.status === "stopped") {
    return (
      <PromptLine
        tool={tool}
        icon={null}
        label={tool.status === "stopped" ? t("chat.question.title") : t("chat.question.waiting")}
        detail={first}
      />
    );
  }
  if (isDeclined(tool)) {
    return (
      <PromptLine
        tool={tool}
        icon={<Ban className="size-3.5 shrink-0 text-muted-foreground" />}
        label={t("chat.question.skipped")}
        detail={first}
      />
    );
  }
  const answers = answersOf(tool);
  return (
    <div
      className="my-1 flex max-w-full items-start gap-2 self-start rounded-(--radius-raised) border border-border px-3 py-2 text-app-ui-sm"
      data-tool-use-id={tool.id}
      data-testid="chat-answered-questions"
    >
      <MessageCircleQuestion aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <dl className="flex min-w-0 flex-1 flex-col gap-2">
        {questions.map((q) => {
          const answer = answers[q.question];
          return (
            <div key={q.question} className="min-w-0">
              <dt className="line-clamp-3 break-words text-muted-foreground" title={q.question}>
                {q.question}
              </dt>
              <dd className="mt-0.5 flex items-start gap-1.5 break-words">
                {answer ? (
                  <>
                    <Check
                      aria-hidden
                      className="mt-0.5 size-3.5 shrink-0 text-[var(--state-success-fg)]"
                    />
                    <span className="min-w-0 font-medium text-foreground">{answer}</span>
                  </>
                ) : (
                  <span className="text-muted-foreground italic">
                    {t("chat.question.no_answer")}
                  </span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

/** The plan's first line, its Markdown marks off, to name it while folded. */
function planTitle(plan: string): string {
  const line = plan.split("\n").find((each) => each.trim() !== "") ?? "";
  return line
    .replace(/^#+\s*/, "")
    .replace(/`|\*\*/g, "")
    .trim();
}

/** Claude's plan and how it went: approved, or sent back with what to change. */
export function PlanOutcome({
  tool,
  workspaceId,
  cwd,
  rootPath,
}: {
  tool: ToolCall;
  workspaceId: string;
  cwd: string;
  rootPath: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const input = (tool.input ?? {}) as Record<string, unknown>;
  const plan = typeof input.plan === "string" ? input.plan : "";
  const title = planTitle(plan);
  if (isPending(tool) || tool.status === "stopped") {
    return (
      <PromptLine
        tool={tool}
        icon={null}
        label={tool.status === "stopped" ? t("chat.plan.title") : t("chat.plan.waiting")}
        detail={title}
      />
    );
  }
  const declined = isDeclined(tool);
  const reason = declined ? declineReason(tool) : "";
  return (
    <div className="my-1 text-app-ui-sm" data-tool-use-id={tool.id} data-testid="chat-plan-outcome">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        disabled={!plan}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-(--radius-control) px-1.5 py-1 text-left hover:bg-[var(--state-hover-bg)] disabled:hover:bg-transparent"
      >
        <ListTodo
          aria-hidden
          className={cn(
            "size-3.5 shrink-0",
            declined ? "text-muted-foreground" : "text-[var(--state-success-fg)]",
          )}
        />
        <span className="shrink-0 font-medium text-foreground">
          {declined ? t("chat.plan.declined") : t("chat.plan.approved")}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={title}>
          {title}
        </span>
        {plan &&
          (open ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          ))}
      </button>
      {reason && (
        <div className="mt-0.5 ml-5 border-l-2 border-border pl-2 whitespace-pre-wrap break-words text-muted-foreground">
          {reason}
        </div>
      )}
      {open && plan && (
        <div className="app-scrollbar mt-1 mb-2 ml-5 max-h-96 overflow-y-auto rounded-(--radius-control) border border-border px-3 py-2">
          <ChatMarkdown text={plan} workspaceId={workspaceId} cwd={cwd} rootPath={rootPath} />
        </div>
      )}
    </div>
  );
}
