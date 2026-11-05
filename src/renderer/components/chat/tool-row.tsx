// One tool call as a row under its turn: what ran and how it ended, folded
// by default. Open, an edit shows its patch and a command its output.

import { Ban, Check, ChevronDown, ChevronRight, CircleStop, LoaderCircle, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ImageBlock, ToolCall } from "../../services/chat/model";
import { cn } from "../../utils/cn";

interface ToolRowProps {
  tool: ToolCall | undefined;
  toolUseId: string;
  /** Every tool call the tab knows, for an Agent call's own calls. */
  tools: Record<string, ToolCall>;
  cwd: string;
}

/** Tools that run a subagent, whose calls are listed under them. */
const AGENT_TOOLS = new Set(["Agent", "Task"]);

/** Longest output an open row shows; the rest is cut. */
const MAX_OUTPUT_CHARS = 20_000;

export function ToolRow({ tool, toolUseId, tools, cwd }: ToolRowProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const name = tool?.name || "tool";
  const summary = tool ? toolSummary(tool, cwd) : "";
  const status = tool?.status ?? "running";
  const images = tool?.result?.images ?? [];
  const children =
    tool && AGENT_TOOLS.has(tool.name)
      ? Object.values(tools).filter((t) => t.parentToolUseId === toolUseId)
      : [];
  return (
    <div className="my-1 text-app-ui-sm" data-tool-use-id={toolUseId}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-(--radius-control) px-1.5 py-1 text-left hover:bg-[var(--state-hover-bg)]"
        aria-expanded={open}
      >
        <StatusIcon status={status} />
        <span className="shrink-0 font-medium text-foreground">{name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground" title={summary}>
          {summary}
        </span>
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

function StatusIcon({ status }: { status: ToolCall["status"] }) {
  const cls = "size-3.5 shrink-0";
  switch (status) {
    case "streaming":
    case "running":
      return <LoaderCircle className={cn(cls, "animate-spin text-muted-foreground")} />;
    case "done":
      return <Check className={cn(cls, "text-[var(--state-success-fg,currentColor)]")} />;
    case "error":
      return <X className={cn(cls, "text-[var(--state-error-fg,currentColor)]")} />;
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
    body = <PatchView hunks={patch as Hunk[]} />;
  } else if (tool.name === "Write" && typeof input.content === "string") {
    body = <Pre text={input.content} added />;
  } else if (
    tool.name === "Edit" &&
    typeof input.old_string === "string" &&
    typeof input.new_string === "string"
  ) {
    body = (
      <PatchView
        hunks={[{ lines: [...prefix(input.old_string, "-"), ...prefix(input.new_string, "+")] }]}
      />
    );
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
        <div className="border-b border-border bg-[var(--state-hover-bg)] px-2 py-1 font-mono text-app-micro whitespace-pre-wrap break-all">
          $ {input.command}
        </div>
      )}
      {body}
      {(tool.result?.images.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-border p-2">
          {tool.result?.images.map((image, i) => (
            <img
              // biome-ignore lint/suspicious/noArrayIndexKey: a result's images keep their order
              key={i}
              src={imageSrc(image)}
              alt=""
              className="max-h-64 max-w-full rounded-sm object-contain"
            />
          ))}
        </div>
      )}
    </div>
  );
}

function imageSrc(image: ImageBlock): string {
  return `data:${image.mediaType};base64,${image.data}`;
}

interface Hunk {
  oldStart?: number;
  newStart?: number;
  lines: string[];
}

function prefix(text: string, mark: string): string[] {
  return text.split("\n").map((line) => `${mark}${line}`);
}

function PatchView({ hunks }: { hunks: Hunk[] }) {
  return (
    <div className="app-scrollbar max-h-80 overflow-auto font-mono text-app-micro leading-5">
      {hunks.map((hunk, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: hunks have no identity of their own
        <div key={i} className={i > 0 ? "border-t border-border" : ""}>
          {hunk.lines.map((line, j) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: patch lines have no identity of their own
              key={j}
              className={cn(
                "px-2 whitespace-pre-wrap break-all",
                line.startsWith("+") && "bg-[var(--diff-added-bg,rgba(46,160,67,0.15))]",
                line.startsWith("-") && "bg-[var(--diff-removed-bg,rgba(248,81,73,0.15))]",
              )}
            >
              {line || " "}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function Pre({ text, added = false }: { text: string; added?: boolean }) {
  const shown = text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…` : text;
  return (
    <pre
      className={cn(
        "app-scrollbar m-0 max-h-80 overflow-auto px-2 py-1.5 font-mono text-app-micro leading-5 whitespace-pre-wrap break-all",
        added && "bg-[var(--diff-added-bg,rgba(46,160,67,0.10))]",
      )}
    >
      {shown}
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
  if (path) return relativeTo(path, cwd);
  const value = pick("command", "pattern", "url", "query", "description", "prompt", "skill");
  if (value) return value.split("\n")[0];
  if (tool.status === "streaming" && tool.partialInput) return tool.partialInput.slice(0, 120);
  return "";
}

function relativeTo(path: string, cwd: string): string {
  const root = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return path.startsWith(root) ? path.slice(root.length) : path;
}
