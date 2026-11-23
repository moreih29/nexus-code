import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ListTodo,
  MessageCircleQuestion,
  Pencil,
  Send,
  Shield,
} from "lucide-react";
import {
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { PermissionAnswer } from "../../services/chat/claude/controller";
import type { PermissionRequest } from "../../services/chat/model";
import { type Scope, scopesOf } from "../../services/chat/permission-scopes";
import { cn } from "../../utils/cn";
import { isImeComposing } from "../../utils/ime";
import { Button } from "../ui/button";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Keycap } from "../ui/keycap";
import { tooltipProps } from "../ui/tooltip";
import { useAgentContext } from "./chat-agent";
import { ChatMarkdown } from "./chat-markdown";
import { Highlighted } from "./code-highlight";
import { isUnsandboxed, ToolDetail, toolSummary } from "./tool-row";

interface PermissionCardProps {
  requests: PermissionRequest[];
  workspaceId: string;
  cwd: string;
  rootPath: string;
  planModeOptions?: boolean;
  onAnswer: (request: PermissionRequest, answer: PermissionAnswer) => void;
  onToMain?: () => void;
}

export function PermissionCard({
  requests,
  workspaceId,
  cwd,
  rootPath,
  planModeOptions = true,
  onAnswer,
  onToMain,
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
      className={PERMISSION_CARD_CLASS}
      aria-label={t("chat.permission.aria")}
      data-testid="chat-permission"
    >
      {onToMain && (
        <div
          className="mb-2 flex items-center gap-2 text-app-micro text-muted-foreground"
          data-testid="chat-permission-main"
        >
          <span className="min-w-0 flex-1 truncate">{t("chat.strip.permission_waiting")}</span>
          <button
            type="button"
            onClick={onToMain}
            className="shrink-0 rounded-(--radius-control) px-1.5 py-0.5 font-medium whitespace-nowrap hover:bg-[var(--state-hover-bg)]"
          >
            {t("chat.strip.to_main")}
          </button>
        </div>
      )}
      {requests.length > 1 && (
        <RequestPager shown={shown} total={requests.length} onShow={setIndex} className="mb-2" />
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
          planModeOptions={planModeOptions}
        />
      ) : (
        <ToolApproval key={request.requestId} request={request} onAnswer={onAnswer} cwd={cwd} />
      )}
    </section>
  );
}

export const PERMISSION_CARD_CLASS =
  "rounded-(--radius-raised) border border-border border-l-2 border-l-[var(--state-warning-border)] bg-popover p-3 text-app-ui-sm focus-within:border-ring focus-within:border-l-[var(--state-warning-border)]";

export function RequestPager({
  shown,
  total,
  onShow,
  className,
}: {
  shown: number;
  total: number;
  onShow: (index: number) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "flex items-center justify-end gap-1 text-app-micro text-muted-foreground",
        className,
      )}
    >
      <button
        type="button"
        disabled={shown === 0}
        onClick={() => onShow(shown - 1)}
        aria-label={t("chat.permission.previous")}
        {...tooltipProps(t("chat.permission.previous"))}
        className="rounded-(--radius-control) p-0.5 hover:bg-[var(--state-hover-bg)] disabled:opacity-40"
      >
        <ChevronLeft className="size-3.5" />
      </button>
      <span>{t("chat.permission.page", { current: shown + 1, total })}</span>
      <button
        type="button"
        disabled={shown === total - 1}
        onClick={() => onShow(shown + 1)}
        aria-label={t("chat.permission.next")}
        {...tooltipProps(t("chat.permission.next"))}
        className="rounded-(--radius-control) p-0.5 hover:bg-[var(--state-hover-bg)] disabled:opacity-40"
      >
        <ChevronRight className="size-3.5" />
      </button>
    </div>
  );
}

interface FormProps {
  request: PermissionRequest;
  onAnswer: (request: PermissionRequest, answer: PermissionAnswer) => void;
}

function chatTabOf(el: Element): Element | null {
  return el.closest(
    '[data-testid="claude-tab"], [data-testid="codex-tab"], [data-testid="remote-chat"]',
  );
}

function isEmptyField(el: Element): boolean {
  return (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) && el.value === "";
}

function composerOf(tab: Element | null): HTMLTextAreaElement | null {
  return tab?.querySelector<HTMLTextAreaElement>('[data-testid="chat-composer"] textarea') ?? null;
}

export function focusChatTab(tab: Element | null): void {
  const card = tab?.querySelector<HTMLElement>('[data-testid="chat-permission"] [tabindex="-1"]');
  if (card) takeKeys(card, tab);
  else composerOf(tab)?.focus({ preventScroll: true });
}

function giveKeys(card: HTMLElement | null): void {
  if (card) takeKeys(card, chatTabOf(card));
}

const passing = new WeakMap<HTMLTextAreaElement, { card: Element; stop: () => void }>();

function takeKeys(card: HTMLElement, tab: Element | null): void {
  const box = composerOf(tab);
  if (!box || box.value !== "") {
    card.focus({ preventScroll: true });
    return;
  }
  passing.get(box)?.stop();
  const pass = (event: globalThis.KeyboardEvent) => {
    if (box.value !== "" || !card.isConnected) {
      stop();
      return;
    }
    if (isImeComposing(event)) return;
    const passed = new KeyboardEvent("keydown", {
      key: event.key,
      code: event.code,
      location: event.location,
      repeat: event.repeat,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      bubbles: true,
      cancelable: true,
    });
    card.dispatchEvent(passed);
    if (passed.defaultPrevented) event.preventDefault();
  };
  const stop = () => {
    box.removeEventListener("keydown", pass);
    box.removeEventListener("input", stop);
    box.removeEventListener("blur", stop);
    delete box.dataset.cardKeys;
    if (passing.get(box)?.stop === stop) passing.delete(box);
  };
  box.addEventListener("keydown", pass);
  box.addEventListener("input", stop);
  box.addEventListener("blur", stop);
  box.dataset.cardKeys = "";
  passing.set(box, { card, stop });
  box.focus({ preventScroll: true });
}

function onScreen(el: Element | null): el is HTMLElement {
  return el instanceof HTMLElement && el.checkVisibility({ visibilityProperty: true });
}

function useTakeKeyboard(ref: RefObject<HTMLElement | null>, requestId: string): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || !requestId) return;
    const tab = chatTabOf(el);
    const active = document.activeElement;
    const idle =
      active === null ||
      active === document.body ||
      (tab?.contains(active) === true && isEmptyField(active));
    if (idle && onScreen(el)) takeKeys(el, tab);
    return () => {
      const box = composerOf(tab);
      const held = box ? passing.get(box) : undefined;
      if (held?.card === el) held.stop();
      const now = document.activeElement;
      if ((now === null || now === document.body || el.contains(now)) && onScreen(box)) box.focus();
    };
  }, [ref, requestId]);
}

function passToComposer(event: KeyboardEvent, card: Element): void {
  if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return;
  composerOf(chatTabOf(card))?.focus();
}

function reasonKeys(event: KeyboardEvent, send: () => void, back: () => void): void {
  if (isImeComposing(event)) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    back();
  } else if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    send();
  }
}

function BackButton({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      onClick={onBack}
      tooltip={t("chat.permission.back")}
      shortcut="Esc"
    >
      <ArrowLeft className="size-4" />
    </Button>
  );
}

const REASON_CLASS =
  "app-scrollbar w-full resize-none rounded-(--radius-control) border border-border bg-background px-2 py-1.5 text-app-ui-sm outline-none focus:border-ring";

function ToolApproval({ request, onAnswer, cwd }: FormProps & { cwd: string }) {
  const { t } = useTranslation();
  const agent = useAgentContext();
  const root = useRef<HTMLDivElement>(null);
  const [denying, setDenying] = useState(false);
  const [message, setMessage] = useState("");
  useTakeKeyboard(root, request.requestId);
  const name = request.displayName || request.toolName;
  const tool = request.preview ?? {
    id: request.toolUseId ?? request.requestId,
    name: request.toolName,
    input: request.input,
    status: "running" as const,
    parentToolUseId: null,
  };
  const preview = request.preview !== undefined || hasPreview(request.toolName);
  const summary = wholeCommand(tool.input) ?? toolSummary(tool, cwd);
  const scopes = scopesOf(request.suggestions, t);
  const deny = (stop: boolean) =>
    onAnswer(request, { kind: stop ? "deny-stop" : "deny", message: message.trim() || undefined });
  const back = () => {
    setDenying(false);
    giveKeys(root.current);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the card's keys, taken as it shows
    <div
      ref={root}
      tabIndex={-1}
      className="flex flex-col gap-2 outline-none"
      onKeyDown={(event) => {
        if (denying || event.target !== event.currentTarget || isImeComposing(event)) return;
        if (event.key === "Enter") {
          event.preventDefault();
          onAnswer(request, { kind: "allow" });
        } else {
          passToComposer(event, event.currentTarget);
        }
      }}
    >
      <div className="flex items-start gap-2">
        <Shield aria-hidden className="mt-0.5 size-4 shrink-0 text-[var(--state-warning-fg)]" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-semibold text-foreground">{name}</span>
            {request.description && (
              <span className="min-w-0 text-muted-foreground">{request.description}</span>
            )}
            {request.agentId && (
              <span className="rounded-(--radius-control) bg-muted px-1.5 text-app-micro text-muted-foreground">
                {t("chat.permission.from_subagent")}
              </span>
            )}
          </div>
          {isUnsandboxed(request.input) && (
            <div className="text-app-micro text-[var(--state-warning-fg)]">
              {t("chat.tool.unsandboxed_hint")}
            </div>
          )}
          {request.decisionReason && (
            <div className="text-app-micro text-muted-foreground">{request.decisionReason}</div>
          )}
        </div>
      </div>
      {summary && !preview && (
        <div
          className={cn(
            "code-hl rounded-(--radius-control) bg-background px-2 py-1 font-mono text-foreground",
            summary.includes("\n")
              ? "max-h-40 overflow-auto whitespace-pre-wrap break-all"
              : "truncate",
          )}
          title={summary}
        >
          {request.toolName === "Bash" ? <Highlighted code={summary} language="bash" /> : summary}
        </div>
      )}
      {preview && <ToolDetail tool={tool} className="mt-0 mb-0 ml-0" />}
      {denying ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            deny(false);
          }}
        >
          <textarea
            // biome-ignore lint/a11y/noAutofocus: the user just asked to say why
            autoFocus
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => reasonKeys(event, () => deny(false), back)}
            placeholder={t("chat.permission.deny_placeholder", agent)}
            aria-label={t("chat.permission.deny_reason")}
            rows={2}
            className={REASON_CLASS}
          />
          <div className="flex items-center gap-2">
            <BackButton onBack={back} />
            <span className="flex-1" />
            <Button type="button" size="sm" variant="outline" onClick={() => deny(true)}>
              {t("chat.permission.deny_stop")}
            </Button>
            <Button
              type="submit"
              size="sm"
              variant="outline"
              className="pr-1.5 text-[var(--state-error-fg)]"
            >
              {t("chat.permission.deny_send")}
              <Keycap>↵</Keycap>
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => setDenying(true)}>
            {t("chat.permission.deny")}
          </Button>
          {scopes.length > 0 && (
            <AllowAlways
              scopes={scopes}
              onAllow={(suggestions) => onAnswer(request, { kind: "allow-always", suggestions })}
            />
          )}
          <Button size="sm" className="pr-1.5" onClick={() => onAnswer(request, { kind: "allow" })}>
            {t("chat.permission.allow")}
            <Keycap>↵</Keycap>
          </Button>
        </div>
      )}
    </div>
  );
}

function AllowAlways({
  scopes,
  onAllow,
}: {
  scopes: Scope[];
  onAllow: (suggestions?: unknown[]) => void;
}) {
  const { t } = useTranslation();
  const several = scopes.length > 1;
  const all = (
    <Button
      size="sm"
      variant="outline"
      title={scopes.map((scope) => scope.label).join(" · ")}
      onClick={() => onAllow()}
      className={cn(several && "rounded-r-none")}
    >
      {t("chat.permission.allow_always")}
    </Button>
  );
  if (!several) return all;
  return (
    <span className="inline-flex">
      {all}
      <DropdownMenuRoot>
        <DropdownMenuTrigger>
          <Button
            size="sm"
            variant="outline"
            className="rounded-l-none border-l-0 px-1.5"
            title={t("chat.permission.allow_always_one")}
            aria-label={t("chat.permission.allow_always_one")}
          >
            <ChevronDown className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {scopes.map((scope) => (
            <DropdownMenuItem key={scope.label} onSelect={() => onAllow([scope.suggestion])}>
              <span className="max-w-[420px] truncate">{scope.label}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenuRoot>
    </span>
  );
}

function wholeCommand(input: unknown): string | undefined {
  const command = (input as { command?: unknown } | undefined)?.command;
  if (typeof command !== "string") return undefined;
  const whole = command.trim();
  return whole.includes("\n") ? whole : undefined;
}

function hasPreview(toolName: string): boolean {
  return toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit";
}

export { scopesOf };

export interface Question {
  id?: string;
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

export function questionKey(question: Question): string {
  return question.id ?? question.question;
}

export function readQuestions(input: Record<string, unknown>): Question[] {
  if (!Array.isArray(input.questions)) return [];
  return (input.questions as Record<string, unknown>[])
    .filter((q) => typeof q?.question === "string")
    .map((q) => ({
      ...(typeof q.id === "string" ? { id: q.id } : {}),
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

export const ONWARD_MS = 200;

export function nextUnanswered(unanswered: readonly boolean[], shown: number): number {
  const after = unanswered.findIndex((open, i) => open && i > shown);
  return after >= 0 ? after : unanswered.findIndex((open, i) => open && i !== shown);
}

function QuestionForm({ request, onAnswer }: FormProps) {
  const { t } = useTranslation();
  const root = useRef<HTMLFormElement>(null);
  const otherRef = useRef<HTMLInputElement>(null);
  const questions = readQuestions(request.input);
  const [current, setCurrent] = useState(0);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const onwardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useTakeKeyboard(root, request.requestId);
  useEffect(
    () => () => {
      if (onwardTimer.current) clearTimeout(onwardTimer.current);
    },
    [],
  );

  const answerOf = (q: Question): string => {
    const labels = [...(picked[questionKey(q)] ?? [])];
    const typed = other[questionKey(q)]?.trim();
    if (typed) labels.push(typed);
    return labels.join(", ");
  };
  const answered = questions.filter((q) => answerOf(q) !== "").length;
  const complete = answered === questions.length;
  const shown = Math.min(current, questions.length - 1);
  const q = questions[shown];

  const unanswered = questions.map((each) => answerOf(each) === "");
  const next = nextUnanswered(unanswered, shown);

  const show = (i: number) => {
    if (onwardTimer.current) clearTimeout(onwardTimer.current);
    onwardTimer.current = null;
    setCurrent(i);
    giveKeys(root.current);
  };
  const submit = () => {
    if (!complete) return;
    const answers = Object.fromEntries(
      questions.map((each) => [questionKey(each), answerOf(each)]),
    );
    onAnswer(request, { kind: "allow", updatedInput: { ...request.input, answers } });
  };
  const onward = () => {
    if (complete) {
      submit();
      return;
    }
    if (next >= 0) show(next);
  };
  const pick = (question: Question, label: string) => {
    toggle(question, label);
    if (question.multiSelect || next < 0) return;
    if (onwardTimer.current) clearTimeout(onwardTimer.current);
    onwardTimer.current = setTimeout(() => show(next), ONWARD_MS);
  };
  const toggle = (question: Question, label: string) => {
    setPicked((prev) => {
      const now = prev[questionKey(question)] ?? [];
      if (question.multiSelect) {
        return {
          ...prev,
          [questionKey(question)]: now.includes(label)
            ? now.filter((l) => l !== label)
            : [...now, label],
        };
      }
      return { ...prev, [questionKey(question)]: [label] };
    });
    if (!question.multiSelect) setOther((prev) => ({ ...prev, [questionKey(question)]: "" }));
  };

  if (!q) return null;
  return (
    <form
      ref={root}
      tabIndex={-1}
      className="flex flex-col gap-2.5 outline-none"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        if (target !== event.currentTarget && !target.dataset.option) return;
        if (isImeComposing(event) || event.metaKey || event.ctrlKey || event.altKey) return;
        const number = /^[1-9]$/.test(event.key) ? Number(event.key) : 0;
        if (number > 0 && number <= q.options.length) {
          event.preventDefault();
          pick(q, q.options[number - 1].label);
        } else if (number === q.options.length + 1) {
          event.preventDefault();
          otherRef.current?.focus();
        } else if (event.key === "Enter") {
          event.preventDefault();
          onward();
        } else if (event.key === "ArrowRight" && shown < questions.length - 1) {
          event.preventDefault();
          show(shown + 1);
        } else if (event.key === "ArrowLeft" && shown > 0) {
          event.preventDefault();
          show(shown - 1);
        } else if (target === event.currentTarget) {
          passToComposer(event, event.currentTarget);
        }
      }}
    >
      {questions.length > 1 ? (
        <div className="flex flex-wrap gap-1.5" role="tablist">
          {questions.map((each, i) => {
            const done = answerOf(each) !== "";
            const here = i === shown;
            return (
              <button
                type="button"
                role="tab"
                key={questionKey(each)}
                aria-selected={here}
                onClick={() => show(i)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-(--radius-control) px-1.5 py-0.5 text-app-micro",
                  here
                    ? "bg-[var(--state-active-bg)] text-foreground ring-1 ring-ring"
                    : done
                      ? "text-[var(--state-success-fg)] hover:bg-[var(--state-hover-bg)]"
                      : "text-muted-foreground hover:bg-[var(--state-hover-bg)]",
                )}
              >
                {done && !here && <Check aria-hidden className="size-3" />}
                {each.header ?? t("chat.question.numbered", { n: i + 1 })}
              </button>
            );
          })}
        </div>
      ) : (
        q.header && (
          <span className="self-start rounded-(--radius-control) bg-muted px-1.5 py-0.5 text-app-micro text-muted-foreground">
            {q.header}
          </span>
        )
      )}
      <QuestionText key={questionKey(q)} text={q.question} />
      <div className="flex flex-col gap-1.5">
        {q.options.map((option, i) => {
          const on = picked[questionKey(q)]?.includes(option.label) ?? false;
          return (
            <button
              type="button"
              key={option.label}
              data-option="true"
              onClick={() => {
                pick(q, option.label);
                giveKeys(root.current);
              }}
              aria-pressed={on}
              className={cn(
                "flex items-center gap-2.5 rounded-(--radius-control) border px-2.5 py-1.5 text-left",
                on
                  ? "border-ring bg-[var(--state-active-bg)]"
                  : "border-border hover:bg-[var(--state-hover-bg)]",
              )}
            >
              <Pick multi={q.multiSelect === true} on={on} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium text-foreground">{option.label}</span>
                {option.description && (
                  <span className="text-app-micro text-muted-foreground">{option.description}</span>
                )}
              </span>
              <Keycap className={on ? "text-foreground" : "text-muted-foreground"}>{i + 1}</Keycap>
            </button>
          );
        })}
        <label className="flex items-center gap-2.5 rounded-(--radius-control) border border-dashed border-border px-2.5 py-1.5 focus-within:border-solid focus-within:border-ring">
          <Pencil aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={otherRef}
            value={other[questionKey(q)] ?? ""}
            onChange={(event) => {
              const value = event.target.value;
              setOther((prev) => ({ ...prev, [questionKey(q)]: value }));
              if (value && !q.multiSelect) setPicked((prev) => ({ ...prev, [questionKey(q)]: [] }));
            }}
            onKeyDown={(event) => reasonKeys(event, onward, () => giveKeys(root.current))}
            aria-label={t("chat.question.other")}
            title={t("chat.question.other")}
            className="min-w-0 flex-1 bg-transparent text-app-ui-sm text-foreground outline-none"
          />
          <Keycap className="text-muted-foreground">{q.options.length + 1}</Keycap>
        </label>
      </div>
      <div className="flex items-center gap-2">
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
        <span className="flex-1" />
        {next >= 0 ? (
          <Button
            type="button"
            size="sm"
            disabled={unanswered[shown]}
            onClick={onward}
            className="pr-1.5"
          >
            {t("chat.question.next")}
            <ArrowRight aria-hidden className="size-3.5" />
            <Keycap>↵</Keycap>
          </Button>
        ) : (
          <Button
            type="submit"
            size="sm"
            disabled={!complete}
            className="pr-1.5"
            title={t("chat.question.submit")}
            aria-label={t("chat.question.submit")}
          >
            <Send aria-hidden className="size-3.5" />
            {questions.length > 1 && (
              <span className="tabular-nums">
                {answered}/{questions.length}
              </span>
            )}
            <Keycap>↵</Keycap>
          </Button>
        )}
      </div>
    </form>
  );
}

function Pick({ multi, on }: { multi: boolean; on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-3.5 shrink-0 items-center justify-center border",
        multi ? "rounded-[3px]" : "rounded-full",
        on
          ? multi
            ? "border-primary bg-primary text-primary-foreground"
            : "border-primary text-primary"
          : "border-muted-foreground",
      )}
    >
      {on &&
        (multi ? (
          <Check className="size-3" />
        ) : (
          <span className="size-1.5 rounded-full bg-current" />
        ))}
    </span>
  );
}

const QUESTION_FOLD_PX = 150;

function QuestionText({ text }: { text: string }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && text) setLong(el.scrollHeight > QUESTION_FOLD_PX);
  }, [text]);
  return (
    <div className="flex items-start gap-2">
      <MessageCircleQuestion
        aria-hidden
        className="mt-0.5 size-4 shrink-0 text-[var(--state-warning-fg)]"
      />
      <div className="min-w-0 flex-1">
        <div
          ref={ref}
          className={cn(
            "whitespace-pre-wrap break-words font-medium text-foreground",
            long &&
              !open &&
              "overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]",
          )}
          style={long && !open ? { maxHeight: QUESTION_FOLD_PX } : undefined}
        >
          {text}
        </div>
        {long && (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="mt-1 text-app-micro text-muted-foreground hover:text-foreground"
          >
            {open ? t("chat.question.collapse") : t("chat.question.expand")}
          </button>
        )}
      </div>
    </div>
  );
}

function PlanApproval({
  request,
  onAnswer,
  workspaceId,
  cwd,
  rootPath,
  planModeOptions,
}: FormProps & { workspaceId: string; cwd: string; rootPath: string; planModeOptions: boolean }) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const [changing, setChanging] = useState(false);
  const [feedback, setFeedback] = useState("");
  useTakeKeyboard(root, request.requestId);
  const plan = typeof request.input.plan === "string" ? request.input.plan : "";
  const approve = (mode: "acceptEdits" | "default") =>
    onAnswer(request, {
      kind: "allow",
      ...(planModeOptions
        ? { updatedPermissions: [{ type: "setMode", mode, destination: "session" }] }
        : {}),
    });
  const sendFeedback = () => {
    if (feedback.trim()) onAnswer(request, { kind: "deny", message: feedback.trim() });
  };
  const back = () => {
    setChanging(false);
    giveKeys(root.current);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the card's keys, taken as it shows
    <div
      ref={root}
      tabIndex={-1}
      className="flex flex-col gap-2 outline-none"
      onKeyDown={(event) => {
        if (changing || event.target !== event.currentTarget || isImeComposing(event)) return;
        if (event.key === "Enter") {
          event.preventDefault();
          approve("acceptEdits");
        } else {
          passToComposer(event, event.currentTarget);
        }
      }}
    >
      <div className="flex items-center gap-2 font-semibold text-foreground">
        <ListTodo aria-hidden className="size-4 shrink-0 text-[var(--state-warning-fg)]" />
        {t("chat.plan.title")}
      </div>
      {plan && (
        <div className="app-scrollbar max-h-96 overflow-y-auto rounded-(--radius-control) border border-border px-3 py-2">
          <ChatMarkdown text={plan} workspaceId={workspaceId} cwd={cwd} rootPath={rootPath} />
        </div>
      )}
      {changing ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            sendFeedback();
          }}
        >
          <textarea
            // biome-ignore lint/a11y/noAutofocus: the user just asked to say what to change
            autoFocus
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            onKeyDown={(event) => reasonKeys(event, sendFeedback, back)}
            placeholder={t("chat.plan.feedback_placeholder")}
            aria-label={t("chat.plan.request_changes")}
            rows={3}
            className={REASON_CLASS}
          />
          <div className="flex items-center gap-2">
            <BackButton onBack={back} />
            <span className="flex-1" />
            <Button type="submit" size="sm" className="pr-1.5" disabled={!feedback.trim()}>
              {t("chat.plan.send_feedback")}
              <Keycap>↵</Keycap>
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => setChanging(true)}>
            {t("chat.plan.request_changes")}
          </Button>
          {planModeOptions && (
            <span className="text-app-micro text-muted-foreground">
              {t("chat.plan.accept_edits")}
            </span>
          )}
          <span className="inline-flex">
            <Button
              size="sm"
              className={cn("pr-1.5", planModeOptions && "rounded-r-none")}
              title={planModeOptions ? t("chat.plan.approve_accept_edits") : undefined}
              onClick={() => approve("acceptEdits")}
            >
              {t("chat.plan.approve")}
              <Keycap>↵</Keycap>
            </Button>
            {planModeOptions && (
              <DropdownMenuRoot>
                <DropdownMenuTrigger>
                  <Button
                    size="sm"
                    className="rounded-l-none border-l border-primary-foreground/25 px-1.5"
                    title={t("chat.plan.approve_other")}
                    aria-label={t("chat.plan.approve_other")}
                  >
                    <ChevronDown className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => approve("default")}>
                    {t("chat.plan.approve_manual")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenuRoot>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
