// What Claude asks before a tool runs: the call, and the user's answer.
// AskUserQuestion is answered with choices and ExitPlanMode with the plan's
// approval; every other tool is allowed, allowed for good, or denied.

import { ChevronLeft, ChevronRight, ShieldQuestion } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PermissionAnswer } from "../../services/chat/controller";
import type { PermissionRequest } from "../../services/chat/model";
import { cn } from "../../utils/cn";
import { Button } from "../ui/button";
import { useAgentContext } from "./chat-agent";
import { ChatMarkdown } from "./chat-markdown";
import { isUnsandboxed, ToolDetail, toolSummary } from "./tool-row";

interface PermissionCardProps {
  requests: PermissionRequest[];
  workspaceId: string;
  cwd: string;
  rootPath: string;
  onAnswer: (request: PermissionRequest, answer: PermissionAnswer) => void;
}

export function PermissionCard({
  requests,
  workspaceId,
  cwd,
  rootPath,
  onAnswer,
}: PermissionCardProps) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(0);
  const shown = Math.min(index, requests.length - 1);
  useEffect(() => {
    if (index > requests.length - 1) setIndex(Math.max(0, requests.length - 1));
  }, [index, requests.length]);
  const request = requests[shown];
  if (!request) return null;

  return (
    <section
      className="rounded-(--radius-raised) border border-border bg-popover p-3 text-app-ui-sm"
      aria-label={t("chat.permission.aria")}
      data-testid="chat-permission"
    >
      {requests.length > 1 && (
        <div className="mb-2 flex items-center justify-end gap-1 text-app-micro text-muted-foreground">
          <button
            type="button"
            disabled={shown === 0}
            onClick={() => setIndex(shown - 1)}
            title={t("chat.permission.previous")}
            aria-label={t("chat.permission.previous")}
            className="rounded-(--radius-control) p-0.5 hover:bg-[var(--state-hover-bg)] disabled:opacity-40"
          >
            <ChevronLeft className="size-3.5" />
          </button>
          <span>{t("chat.permission.page", { current: shown + 1, total: requests.length })}</span>
          <button
            type="button"
            disabled={shown === requests.length - 1}
            onClick={() => setIndex(shown + 1)}
            title={t("chat.permission.next")}
            aria-label={t("chat.permission.next")}
            className="rounded-(--radius-control) p-0.5 hover:bg-[var(--state-hover-bg)] disabled:opacity-40"
          >
            <ChevronRight className="size-3.5" />
          </button>
        </div>
      )}
      {request.toolName === "AskUserQuestion" ? (
        <QuestionForm key={request.requestId} request={request} onAnswer={onAnswer} />
      ) : request.toolName === "ExitPlanMode" ? (
        <PlanApproval
          key={request.requestId}
          request={request}
          onAnswer={onAnswer}
          workspaceId={workspaceId}
          cwd={cwd}
          rootPath={rootPath}
        />
      ) : (
        <ToolApproval key={request.requestId} request={request} onAnswer={onAnswer} cwd={cwd} />
      )}
    </section>
  );
}

interface FormProps {
  request: PermissionRequest;
  onAnswer: (request: PermissionRequest, answer: PermissionAnswer) => void;
}

function ToolApproval({ request, onAnswer, cwd }: FormProps & { cwd: string }) {
  const { t } = useTranslation();
  const agent = useAgentContext();
  const [denying, setDenying] = useState(false);
  const [message, setMessage] = useState("");
  const name = request.displayName || request.toolName;
  const tool = request.preview ?? {
    id: request.toolUseId ?? request.requestId,
    name: request.toolName,
    input: request.input,
    status: "running" as const,
    parentToolUseId: null,
  };
  const preview = request.preview !== undefined || hasPreview(request.toolName);
  const summary = toolSummary(tool, cwd);
  const always = describeSuggestions(request.suggestions, t);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-foreground">
            {t("chat.permission.title", { tool: name, ...agent })}
          </div>
          {request.agentId && (
            <div className="text-app-micro text-muted-foreground">
              {t("chat.permission.from_subagent")}
            </div>
          )}
          {isUnsandboxed(request.input) && (
            <div className="text-app-micro text-[var(--state-warning-fg)]">
              {t("chat.tool.unsandboxed_hint")}
            </div>
          )}
          {request.description && (
            <div className="text-muted-foreground">{request.description}</div>
          )}
          {summary && !preview && (
            <div className="mt-1 truncate font-mono text-muted-foreground" title={summary}>
              {summary}
            </div>
          )}
          {request.decisionReason && (
            <div className="mt-1 text-app-micro text-muted-foreground">
              {request.decisionReason}
            </div>
          )}
        </div>
      </div>
      {preview && <ToolDetail tool={tool} className="mt-0 mb-0 ml-0" />}
      {denying ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            onAnswer(request, { kind: "deny", message: message.trim() || undefined });
          }}
        >
          <textarea
            // biome-ignore lint/a11y/noAutofocus: the user just asked to say why
            autoFocus
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t("chat.permission.deny_placeholder", agent)}
            rows={2}
            className="app-scrollbar w-full resize-none rounded-(--radius-control) border border-border bg-background px-2 py-1.5 text-app-ui-sm outline-none focus:border-ring"
          />
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setDenying(false)}>
              {t("chat.permission.back")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                onAnswer(request, { kind: "deny-stop", message: message.trim() || undefined })
              }
            >
              {t("chat.permission.deny_stop")}
            </Button>
            <Button type="submit" size="sm" variant="secondary">
              {t("chat.permission.deny_send")}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setDenying(true)}>
            {t("chat.permission.deny")}
          </Button>
          {always && (
            <Button
              size="sm"
              variant="outline"
              title={always}
              onClick={() => onAnswer(request, { kind: "allow-always" })}
            >
              {t("chat.permission.allow_always")}
            </Button>
          )}
          <Button size="sm" onClick={() => onAnswer(request, { kind: "allow" })}>
            {t("chat.permission.allow")}
          </Button>
        </div>
      )}
      {always && !denying && (
        <div className="text-right text-app-micro text-muted-foreground">{always}</div>
      )}
    </div>
  );
}

/** Tools whose input reads best as the patch or command they carry. */
function hasPreview(toolName: string): boolean {
  return toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit";
}

type Translate = ReturnType<typeof useTranslation>["t"];

/** What "allow always" would add, in words. */
function describeSuggestions(suggestions: unknown[], t: Translate): string {
  const parts: string[] = [];
  for (const raw of suggestions) {
    const s = raw as Record<string, unknown> | null;
    if (!s || typeof s !== "object") continue;
    if (s.type === "addRules" && Array.isArray(s.rules)) {
      for (const rule of s.rules as Record<string, unknown>[]) {
        const name = String(rule.toolName ?? "");
        parts.push(rule.ruleContent ? `${name}(${String(rule.ruleContent)})` : name);
      }
    } else if (s.type === "setMode" && typeof s.mode === "string") {
      parts.push(t("chat.permission.suggest_mode", { mode: t(`chat.mode.${s.mode}`) }));
    } else if (s.type === "session") {
      // Codex: the same call, allowed again without asking until the program ends.
      parts.push(t("chat.permission.suggest_session"));
    } else if (s.type === "addDirectories" && Array.isArray(s.directories)) {
      parts.push(
        t("chat.permission.suggest_dirs", { dirs: (s.directories as string[]).join(", ") }),
      );
    }
  }
  return parts.join(" · ");
}

interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

function readQuestions(input: Record<string, unknown>): Question[] {
  if (!Array.isArray(input.questions)) return [];
  return (input.questions as Record<string, unknown>[])
    .filter((q) => typeof q?.question === "string")
    .map((q) => ({
      question: q.question as string,
      header: typeof q.header === "string" ? q.header : undefined,
      multiSelect: q.multiSelect === true,
      options: Array.isArray(q.options)
        ? (q.options as Record<string, unknown>[])
            .filter((o) => typeof o?.label === "string")
            .map((o) => ({
              label: o.label as string,
              description: typeof o.description === "string" ? o.description : undefined,
            }))
        : [],
    }));
}

function QuestionForm({ request, onAnswer }: FormProps) {
  const { t } = useTranslation();
  const questions = readQuestions(request.input);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});

  const answerOf = (q: Question): string => {
    const labels = [...(picked[q.question] ?? [])];
    const typed = other[q.question]?.trim();
    if (typed) labels.push(typed);
    return labels.join(", ");
  };
  const complete = questions.every((q) => answerOf(q) !== "");

  const toggle = (q: Question, label: string) => {
    setPicked((prev) => {
      const now = prev[q.question] ?? [];
      if (q.multiSelect) {
        return {
          ...prev,
          [q.question]: now.includes(label) ? now.filter((l) => l !== label) : [...now, label],
        };
      }
      return { ...prev, [q.question]: [label] };
    });
    if (!q.multiSelect) setOther((prev) => ({ ...prev, [q.question]: "" }));
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!complete) return;
        const answers: Record<string, string> = {};
        for (const q of questions) answers[q.question] = answerOf(q);
        onAnswer(request, { kind: "allow", updatedInput: { ...request.input, answers } });
      }}
    >
      {questions.map((q) => (
        <fieldset key={q.question} className="flex flex-col gap-1.5">
          <legend className="mb-1 font-medium text-foreground">
            {q.header && (
              <span className="mr-1.5 rounded-(--radius-control) bg-muted px-1.5 py-0.5 text-app-micro text-muted-foreground">
                {q.header}
              </span>
            )}
            {q.question}
          </legend>
          {q.options.map((option) => {
            const on = picked[q.question]?.includes(option.label) ?? false;
            return (
              <button
                type="button"
                key={option.label}
                onClick={() => toggle(q, option.label)}
                aria-pressed={on}
                className={cn(
                  "flex flex-col items-start rounded-(--radius-control) border px-2.5 py-1.5 text-left",
                  on
                    ? "border-ring bg-[var(--state-active-bg)]"
                    : "border-border hover:bg-[var(--state-hover-bg)]",
                )}
              >
                <span className="text-foreground">{option.label}</span>
                {option.description && (
                  <span className="text-app-micro text-muted-foreground">{option.description}</span>
                )}
              </button>
            );
          })}
          <input
            value={other[q.question] ?? ""}
            onChange={(e) => {
              const value = e.target.value;
              setOther((prev) => ({ ...prev, [q.question]: value }));
              if (value && !q.multiSelect) setPicked((prev) => ({ ...prev, [q.question]: [] }));
            }}
            placeholder={t("chat.question.other")}
            className="rounded-(--radius-control) border border-border bg-background px-2 py-1 text-app-ui-sm outline-none focus:border-ring"
          />
        </fieldset>
      ))}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() =>
            onAnswer(request, { kind: "deny", message: "The user skipped the questions." })
          }
        >
          {t("chat.question.skip")}
        </Button>
        <Button type="submit" size="sm" disabled={!complete}>
          {t("chat.question.submit")}
        </Button>
      </div>
    </form>
  );
}

function PlanApproval({
  request,
  onAnswer,
  workspaceId,
  cwd,
  rootPath,
}: FormProps & { workspaceId: string; cwd: string; rootPath: string }) {
  const { t } = useTranslation();
  const [changing, setChanging] = useState(false);
  const [feedback, setFeedback] = useState("");
  const plan = typeof request.input.plan === "string" ? request.input.plan : "";
  const approve = (mode: "acceptEdits" | "default") =>
    onAnswer(request, {
      kind: "allow",
      updatedPermissions: [{ type: "setMode", mode, destination: "session" }],
    });

  return (
    <div className="flex flex-col gap-2">
      <div className="font-medium text-foreground">{t("chat.plan.title")}</div>
      {plan && (
        <div className="app-scrollbar max-h-96 overflow-y-auto rounded-(--radius-control) border border-border px-3 py-2">
          <ChatMarkdown text={plan} workspaceId={workspaceId} cwd={cwd} rootPath={rootPath} />
        </div>
      )}
      {changing ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!feedback.trim()) return;
            onAnswer(request, { kind: "deny", message: feedback.trim() });
          }}
        >
          <textarea
            // biome-ignore lint/a11y/noAutofocus: the user just asked to say what to change
            autoFocus
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder={t("chat.plan.feedback_placeholder")}
            rows={3}
            className="app-scrollbar w-full resize-none rounded-(--radius-control) border border-border bg-background px-2 py-1.5 text-app-ui-sm outline-none focus:border-ring"
          />
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setChanging(false)}>
              {t("chat.permission.back")}
            </Button>
            <Button type="submit" size="sm" disabled={!feedback.trim()}>
              {t("chat.plan.send_feedback")}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setChanging(true)}>
            {t("chat.plan.request_changes")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => approve("default")}>
            {t("chat.plan.approve_manual")}
          </Button>
          <Button size="sm" onClick={() => approve("acceptEdits")}>
            {t("chat.plan.approve_accept_edits")}
          </Button>
        </div>
      )}
    </div>
  );
}
