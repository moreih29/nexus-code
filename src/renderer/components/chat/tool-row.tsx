// One tool call as a row under its turn: what ran and how it ended, folded
// by default. Open, an edit shows its patch and a command its output.

import { Ban, Check, ChevronDown, ChevronRight, CircleStop, LoaderCircle, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { imageFileOf, imageSrc } from "../../services/chat/image-look";
import { slashWindowsPath } from "../../services/chat/links";
import type { ToolCall } from "../../services/chat/model";
import { cn } from "../../utils/cn";
import { ChatImage } from "./chat-image";
import { Highlighted, highlightCode, languageOf } from "./code-highlight";

interface ToolRowProps {
  tool: ToolCall | undefined;
  toolUseId: string;
  /** Every tool call the tab knows, for an Agent call's own calls. */
  tools: Record<string, ToolCall>;
  cwd: string;
  /** Sends a running command or subagent to the background, as Ctrl+B does in the terminal. */
  onBackground?: (toolUseId: string) => void;
}

/** Tools that run a subagent, whose calls are listed under them. */
const AGENT_TOOLS = new Set(["Agent", "Task"]);

/** Tools that run commands, and those that change files: each family has its hue. */
const COMMAND_TOOLS = new Set(["Bash", "BashOutput", "KillShell", "KillBash", "PowerShell"]);
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "Delete"]);

/** A tool's name in its family's syntax hue, so commands, edits and the rest read apart. */
export function toolTint(name: string): string {
  if (COMMAND_TOOLS.has(name)) return "text-[var(--syntax-function)]";
  if (EDIT_TOOLS.has(name)) return "text-[var(--syntax-type)]";
  return "text-[var(--syntax-constant)]";
}

/** Longest output an open row shows; the rest is cut. */
const MAX_OUTPUT_CHARS = 20_000;

export function ToolRow({ tool, toolUseId, tools, cwd, onBackground }: ToolRowProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const name = tool?.displayName || tool?.name || "tool";
  const summary = tool ? toolSummary(tool, cwd) : "";
  const status = tool?.status ?? "running";
  const images = tool?.result?.images ?? [];
  const unsandboxed = tool ? isUnsandboxed(tool.input) : false;
  const children =
    tool && AGENT_TOOLS.has(tool.name)
      ? Object.values(tools).filter((t) => t.parentToolUseId === toolUseId)
      : [];
  const backgroundable = onBackground && tool && canBackground(tool);
  return (
    <div className="my-1 text-app-ui-sm" data-tool-use-id={toolUseId}>
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-(--radius-control) px-1.5 py-1 text-left hover:bg-[var(--state-hover-bg)]"
          aria-expanded={open}
        >
          <StatusIcon status={status} />
          <span className={cn("shrink-0 font-medium", toolTint(name))}>{name}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground" title={summary}>
            {summary}
          </span>
          {unsandboxed && (
            <span
              className="shrink-0 text-[var(--state-warning-fg)]"
              title={t("chat.tool.unsandboxed_hint")}
            >
              {t("chat.tool.unsandboxed")}
            </span>
          )}
          {status === "denied" && (
            <span className="shrink-0 text-muted-foreground">{t("chat.tool.denied")}</span>
          )}
          {status === "stopped" && (
            <span className="shrink-0 text-muted-foreground">{t("chat.tool.stopped")}</span>
          )}
          {children.length > 0 && (
            <span className="shrink-0 text-muted-foreground">
              {t("chat.tool.subagent_calls", { count: children.length })}
            </span>
          )}
          {images.length > 0 && (
            <span className="flex shrink-0 items-center gap-0.5">
              {images.slice(0, 3).map((image, i) => (
                <img
                  // biome-ignore lint/suspicious/noArrayIndexKey: a result's images keep their order
                  key={i}
                  src={imageSrc(image)}
                  alt=""
                  className="h-5 max-w-8 rounded-sm border border-border object-cover"
                />
              ))}
            </span>
          )}
          {open ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
        </button>
        {backgroundable && (
          <button
            type="button"
            onClick={() => onBackground(toolUseId)}
            title={t("chat.tool.background_hint")}
            className="shrink-0 rounded-(--radius-control) px-1.5 py-1 text-app-micro text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground"
          >
            {t("chat.tool.background")}
          </button>
        )}
      </div>
      {open && children.length > 0 && (
        <div className="ml-4 border-l border-border pl-2">
          {children.map((child) => (
            <ToolRow key={child.id} toolUseId={child.id} tool={child} tools={tools} cwd={cwd} />
          ))}
        </div>
      )}
      {open && tool && <ToolDetail tool={tool} />}
    </div>
  );
}

/**
 * Whether a running call can go to the background: a command or a
 * subagent on the main thread that was not started there already.
 */
export function canBackground(tool: ToolCall): boolean {
  if (tool.status !== "running" || tool.parentToolUseId) return false;
  if (tool.name !== "Bash" && !AGENT_TOOLS.has(tool.name)) return false;
  return (tool.input as { run_in_background?: unknown } | null)?.run_in_background !== true;
}

/**
 * Whether a command runs outside the sandbox: Claude retries one the
 * sandbox stopped with `dangerouslyDisableSandbox`, which asks again.
 */
export function isUnsandboxed(input: unknown): boolean {
  return (
    typeof input === "object" &&
    input !== null &&
    (input as Record<string, unknown>).dangerouslyDisableSandbox === true
  );
}

function StatusIcon({ status }: { status: ToolCall["status"] }) {
  const cls = "size-3.5 shrink-0";
  switch (status) {
    case "streaming":
    case "running":
      return (
        <LoaderCircle className={cn(cls, "animate-spin text-[var(--state-loading-indicator)]")} />
      );
    case "done":
      return <Check className={cn(cls, "text-[var(--state-success-fg)]")} />;
    case "error":
      return <X className={cn(cls, "text-[var(--state-error-fg)]")} />;
    case "denied":
      return <Ban className={cn(cls, "text-muted-foreground")} />;
    case "stopped":
      return <CircleStop className={cn(cls, "text-muted-foreground")} />;
  }
}

/** A call's input and result: an edit's patch, a command's output. */
export function ToolDetail({ tool, className }: { tool: ToolCall; className?: string }) {
  const { t } = useTranslation();
  const input = (tool.input ?? {}) as Record<string, unknown>;
  const structured = (tool.result?.structured ?? null) as Record<string, unknown> | null;
  const patch =
    structured && Array.isArray(structured.structuredPatch) ? structured.structuredPatch : null;
  const path = [input.file_path, input.notebook_path, input.path].find(
    (value): value is string => typeof value === "string",
  );
  const language = path ? languageOf(path) : undefined;

  let body: React.ReactNode;
  if (
    tool.name === "Bash" &&
    structured &&
    (typeof structured.stdout === "string" || typeof structured.stderr === "string")
  ) {
    const out = [structured.stdout, structured.stderr]
      .filter((s) => typeof s === "string" && s)
      .join("\n");
    body = <Pre text={out || t("chat.tool.no_output")} />;
  } else if (patch && patch.length > 0) {
    body = <PatchView hunks={patch as Hunk[]} language={language} />;
  } else if (tool.name === "Write" && typeof input.content === "string") {
    body = <Pre text={input.content} language={language} added />;
  } else if (
    tool.name === "Edit" &&
    typeof input.old_string === "string" &&
    typeof input.new_string === "string"
  ) {
    body = (
      <PatchView
        hunks={[{ lines: [...prefix(input.old_string, "-"), ...prefix(input.new_string, "+")] }]}
        language={language}
      />
    );
  } else if (tool.name === "Read" && tool.result && numberedLines(tool.result.text)) {
    body = <NumberedView text={tool.result.text} language={language} />;
  } else if (tool.result) {
    body = <Pre text={tool.result.text || t("chat.tool.no_output")} />;
  } else {
    body = <Pre text={tool.partialInput ?? JSON.stringify(tool.input, null, 2)} />;
  }

  return (
    <div
      className={cn(
        "mt-1 mb-2 ml-5 overflow-hidden rounded-(--radius-control) border border-border",
        className,
      )}
    >
      {tool.name === "Bash" && typeof input.command === "string" && (
        <div className="code-hl border-b border-border bg-[var(--state-hover-bg)] px-2 py-1 font-mono text-app-micro whitespace-pre-wrap break-all">
          <span className="text-[var(--state-success-fg)] select-none">$ </span>
          <Highlighted code={input.command} language="bash" />
        </div>
      )}
      {body}
      {tool.result && tool.result.images.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-border p-2">
          {tool.result.images.map((_, i, images) => (
            <ChatImage
              // biome-ignore lint/suspicious/noArrayIndexKey: a result's images keep their order
              key={i}
              images={images}
              index={i}
              file={imageFileOf(tool.input)}
              className="max-h-64 max-w-full rounded-sm object-contain"
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface Hunk {
  oldStart?: number;
  newStart?: number;
  lines: string[];
}

function prefix(text: string, mark: string): string[] {
  return text.split("\n").map((line) => `${mark}${line}`);
}

/** Lines past this many in a patch are shown without syntax colors. */
const MAX_HIGHLIGHTED_LINES = 2_000;

function PatchView({ hunks, language }: { hunks: Hunk[]; language?: string }) {
  let budget = MAX_HIGHLIGHTED_LINES;
  return (
    <div className="code-hl app-scrollbar max-h-80 overflow-auto font-mono text-app-micro leading-5">
      {hunks.map((hunk, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: hunks have no identity of their own
        <div key={i} className={i > 0 ? "border-t border-border" : ""}>
          {hunk.lines.map((line, j) => {
            const marked = line[0] === "+" || line[0] === "-" || line[0] === " ";
            const mark = marked ? line[0] : " ";
            const code = marked ? line.slice(1) : line;
            budget--;
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: patch lines have no identity of their own
                key={j}
                className={cn(
                  "flex pr-2",
                  mark === "+" && "bg-[var(--diff-added-bg)]",
                  mark === "-" && "bg-[var(--diff-removed-bg)]",
                )}
              >
                <span
                  className={cn(
                    "w-5 shrink-0 text-center select-none",
                    mark === "+" && "text-[var(--git-status-added-fg)]",
                    mark === "-" && "text-[var(--git-status-deleted-fg)]",
                  )}
                >
                  {mark}
                </span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-all">
                  {code ? highlightCode(code, budget > 0 ? language : undefined) : " "}
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/**
 * A Read result's lines, each `N\t…` (`N→…` from older versions): their
 * numbers and their code apart. Null for text that is not all such lines.
 */
export function numberedLines(text: string): { numbers: string[]; code: string } | null {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) return null;
  const numbers: string[] = [];
  const code: string[] = [];
  for (const line of lines) {
    const match = /^\s*(\d+)(?:\t|→)(.*)$/.exec(line);
    if (!match) return null;
    numbers.push(match[1] ?? "");
    code.push(match[2] ?? "");
  }
  return { numbers, code: code.join("\n") };
}

/** A file as Read gave it: its line numbers in a gutter, its code in the file's colors. */
function NumberedView({ text, language }: { text: string; language?: string }) {
  // Cut at a line's end, as Pre cuts at MAX_OUTPUT_CHARS.
  const cut = text.length > MAX_OUTPUT_CHARS ? text.lastIndexOf("\n", MAX_OUTPUT_CHARS) : -1;
  const shown = cut > 0 ? text.slice(0, cut) : text;
  const lines = numberedLines(shown);
  if (!lines) return <Pre text={text} />;
  return (
    <div className="code-hl app-scrollbar flex max-h-80 overflow-auto py-1.5 font-mono text-app-micro leading-5">
      <div className="shrink-0 pr-3 pl-2 text-right whitespace-pre text-muted-foreground select-none">
        {lines.numbers.join("\n")}
      </div>
      <pre className="m-0 min-w-0 flex-1 pr-2 whitespace-pre">
        <Highlighted code={lines.code} language={language} />
      </pre>
    </div>
  );
}

function Pre({
  text,
  language,
  added = false,
}: {
  text: string;
  language?: string;
  added?: boolean;
}) {
  const shown = text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…` : text;
  return (
    <pre
      className={cn(
        "code-hl app-scrollbar m-0 max-h-80 overflow-auto px-2 py-1.5 font-mono text-app-micro leading-5 whitespace-pre-wrap break-all",
        added && "bg-[var(--diff-added-bg)]",
      )}
    >
      <Highlighted code={shown} language={language} />
    </pre>
  );
}

/** The one line a tool call is known by: its command, file or query. */
export function toolSummary(tool: ToolCall, cwd: string): string {
  const input = (tool.input ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === "string" && value) return value;
    }
    return "";
  };
  const path = pick("file_path", "notebook_path", "path");
  // A file Codex moved: where it was, then where it is.
  const from = pick("moved_from");
  if (path && from) return `${relativeTo(from, cwd)} → ${relativeTo(path, cwd)}`;
  if (path) return relativeTo(path, cwd);
  const value = pick("command", "pattern", "url", "query", "description", "prompt", "skill");
  if (value) return value.split("\n")[0];
  if (tool.status === "streaming" && tool.partialInput) return tool.partialInput.slice(0, 120);
  return "";
}

function relativeTo(path: string, cwd: string): string {
  const base = slashWindowsPath(cwd);
  const root = base.endsWith("/") ? base : `${base}/`;
  const file = slashWindowsPath(path);
  return file.startsWith(root) ? file.slice(root.length) : path;
}
