import type {
  LspDiagnostic,
  LspDiagnosticSeverity,
  LspLanguage,
  LspStatus,
} from "../../../../../shared/src/contracts/editor/editor-bridge";
import { cn } from "../../lib/utils";

export type StatusBarActiveItem =
  | StatusBarFileItem
  | StatusBarTerminalItem
  | StatusBarAuxiliaryItem
  | null;

export interface StatusBarFileItem {
  kind: "file";
  lspStatus: LspStatus | null;
  diagnostics: readonly LspDiagnostic[];
  language: LspLanguage | string | null;
}

export interface StatusBarTerminalItem {
  kind: "terminal";
  shell?: string | null;
  cwd?: string | null;
  pid?: number | null;
}

export interface StatusBarAuxiliaryItem {
  kind: "diff" | "preview" | "empty";
  label?: string | null;
}

export interface StatusBarPartProps {
  activeItem: StatusBarActiveItem;
  className?: string;
}

export function StatusBarPart({ activeItem, className }: StatusBarPartProps): JSX.Element {
  return (
    <footer
      data-component="status-bar"
      data-slot="status-bar"
      data-status-bar-active-kind={activeItem?.kind ?? "empty"}
      className={cn(
        "flex h-6 shrink-0 items-center justify-between gap-3 border-t border-border bg-card px-3 text-[11px] leading-none text-muted-foreground",
        className,
      )}
    >
      {renderStatusBarContent(activeItem)}
    </footer>
  );
}

function renderStatusBarContent(activeItem: StatusBarActiveItem): JSX.Element {
  if (activeItem?.kind === "file") {
    return <FileStatusBarContent item={activeItem} />;
  }

  if (activeItem?.kind === "terminal") {
    return <TerminalStatusBarContent item={activeItem} />;
  }

  return (
    <div data-status-bar-section="empty" className="min-w-0 truncate">
      {activeItem?.label ?? "Ready"}
    </div>
  );
}

function FileStatusBarContent({ item }: { item: StatusBarFileItem }): JSX.Element {
  return (
    <div data-status-bar-section="file" className="flex min-w-0 items-center gap-3">
      <span data-status-bar-file-lsp="true" className="truncate">
        LSP: {formatLspStatus(item.lspStatus)}
      </span>
      <span data-status-bar-file-diagnostics="true" className="truncate">
        {formatDiagnosticSummary(item.diagnostics)}
      </span>
      <span data-status-bar-file-language="true" className="truncate">
        {formatLanguage(item.language)}
      </span>
    </div>
  );
}

function TerminalStatusBarContent({ item }: { item: StatusBarTerminalItem }): JSX.Element {
  return (
    <div data-status-bar-section="terminal" className="flex min-w-0 items-center gap-1.5 text-foreground">
      <span data-status-bar-terminal-shell="true" className="truncate">
        {basename(item.shell) ?? "shell"}
      </span>
      <StatusSeparator />
      <span data-status-bar-terminal-cwd="true" className="truncate">
        {basename(item.cwd) ?? "workspace"}
      </span>
      <StatusSeparator />
      <span data-status-bar-terminal-pid="true" className="truncate text-muted-foreground">
        {formatPid(item.pid)}
      </span>
    </div>
  );
}

function StatusSeparator(): JSX.Element {
  return (
    <span aria-hidden="true" className="text-muted-foreground/70">
      ·
    </span>
  );
}

export function formatLspStatus(status: LspStatus | null): string {
  return status?.state ?? "off";
}

export function formatDiagnosticSummary(diagnostics: readonly LspDiagnostic[]): string {
  if (diagnostics.length === 0) {
    return "0 problems";
  }

  const counts = countDiagnosticsBySeverity(diagnostics);
  const segments: string[] = [];
  pushDiagnosticSegment(segments, counts.error, "error");
  pushDiagnosticSegment(segments, counts.warning, "warning");

  const secondaryCount = counts.information + counts.hint;
  pushDiagnosticSegment(segments, secondaryCount, "info");

  return segments.length > 0 ? segments.join(", ") : `${diagnostics.length} problems`;
}

export function formatLanguage(language: LspLanguage | string | null): string {
  if (!language) {
    return "Plain text";
  }

  const knownLabels: Record<string, string> = {
    go: "Go",
    javascript: "JavaScript",
    markdown: "Markdown",
    plaintext: "Plain text",
    python: "Python",
    typescript: "TypeScript",
  };
  const normalized = language.trim().toLowerCase();
  return knownLabels[normalized] ?? titleCaseLanguage(language);
}

function countDiagnosticsBySeverity(
  diagnostics: readonly LspDiagnostic[],
): Record<LspDiagnosticSeverity, number> {
  const counts: Record<LspDiagnosticSeverity, number> = {
    error: 0,
    warning: 0,
    information: 0,
    hint: 0,
  };

  for (const diagnostic of diagnostics) {
    counts[diagnostic.severity] += 1;
  }

  return counts;
}

function pushDiagnosticSegment(segments: string[], count: number, label: string): void {
  if (count <= 0) {
    return;
  }

  segments.push(`${count} ${label}${count === 1 ? "" : "s"}`);
}

function titleCaseLanguage(language: string): string {
  return language
    .split(/[-_\s]+/u)
    .filter((part) => part.length > 0)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

function basename(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim().replace(/[\\/]+$/u, "");
  if (trimmed.length === 0) {
    return null;
  }

  return trimmed.split(/[\\/]/u).at(-1) ?? trimmed;
}

function formatPid(pid: number | null | undefined): string {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? String(pid) : "pending";
}
