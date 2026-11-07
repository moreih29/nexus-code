// The release notes view: the recent releases' notes over the panels, as
// quick look shows a file there, with the sidebar and the title bar still
// in sight. The versions are listed on the left, newest first, with the
// running one and any newer one marked; the open release's notes fill the
// right, with an update on offer below them. Esc, the ✕ or a click beside
// it closes it, as does going elsewhere. Links in the notes open in the
// browser.
//
// The notes are the HTML GitHub renders from each release's Markdown,
// sanitized with GitHub's own allowlist before they are shown.

import { ExternalLink, LoaderCircle, ScrollText, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import type { ReleaseNote } from "../../../shared/updates/release-notes";
import { ipcCallResult } from "../../ipc/client";
import { releaseDate, releaseMark, shownNote } from "../../services/updates/release-notes";
import { closeReleaseNotes, loadReleaseNotes } from "../../state/operations/release-notes";
import { useReleaseNotesStore } from "../../state/stores/release-notes";
import { useUpdatesStore } from "../../state/stores/updates";
import { cn } from "../../utils/cn";
import { UpdateSection } from "../settings/panels/about-panel";
import { Button } from "../ui/button";

/** Overlays that open from the view, as a tooltip, and keep it open. */
const FROM_VIEW =
  '[role="dialog"],[role="alertdialog"],[role="menu"],[data-radix-popper-content-wrapper]';

/** Shows the view while it is open; mounted in the panels' area. */
export function ReleaseNotesView() {
  const open = useReleaseNotesStore((s) => s.open);
  return open ? <ReleaseNotesDialog /> : null;
}

function ReleaseNotesDialog() {
  const { t, i18n } = useTranslation();
  const notes = useReleaseNotesStore((s) => s.notes);
  const wanted = useReleaseNotesStore((s) => s.wanted);
  const loading = useReleaseNotesStore((s) => s.loading);
  const error = useReleaseNotesStore((s) => s.error);
  const status = useUpdatesStore((s) => s.status);
  const progress = useUpdatesStore((s) => s.progress);
  const current = __APP_VERSION__;
  const shown = shownNote(notes ?? [], wanted, current);

  // The keys go to the view while it is open, and to the notes once they
  // show; the focus goes back after, unless it went elsewhere, which closed
  // it. Opened again while open, as from the update's popover, it takes the
  // focus back.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const root = rootRef.current;
    return () => {
      const now = document.activeElement;
      if (!now || now === document.body || root?.contains(now)) before?.focus?.();
    };
  }, []);
  const openCount = useReleaseNotesStore((s) => s.openCount);
  useEffect(() => {
    void openCount;
    const root = rootRef.current;
    if (!root || root.contains(document.activeElement)) return;
    const notes = root.querySelector<HTMLElement>("[data-release-body]");
    (notes ?? root).focus({ preventScroll: true });
  }, [openCount]);

  const onBlur = (event: React.FocusEvent) => {
    const next = event.relatedTarget as Element | null;
    if (!next || rootRef.current?.contains(next) || next.closest(FROM_VIEW)) return;
    closeReleaseNotes();
  };

  const step = (by: number) => {
    if (!notes || notes.length === 0 || !shown) return;
    const at = notes.indexOf(shown);
    const next = notes[Math.min(notes.length - 1, Math.max(0, at + by))];
    if (next) useReleaseNotesStore.getState().select(next.version);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeReleaseNotes();
      return;
    }
    // ↑ ↓ move through the versions while the list has the focus.
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    if (!(event.target as HTMLElement).closest("[data-release-list]")) return;
    event.preventDefault();
    step(event.key === "ArrowDown" ? 1 : -1);
  };

  // The update on offer, below the notes; its own release notes are here.
  const offered =
    status?.kind === "newer" ||
    status?.kind === "downloading" ||
    status?.kind === "verifying" ||
    status?.kind === "ready" ||
    status?.kind === "installFailed";

  const icon =
    "inline-flex size-6 shrink-0 items-center justify-center rounded-(--radius-control) text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground";

  let body: ReactNode;
  if (shown && notes) {
    body = (
      <div className="flex min-h-0 flex-1">
        <ReleaseList notes={notes} shown={shown} current={current} locale={i18n.language} />
        <div className="flex min-w-0 flex-1 flex-col">
          <ReleaseBody key={shown.version} note={shown} locale={i18n.language} />
          {offered && (
            <div className="shrink-0 border-t border-border px-6 py-3 text-app-ui-sm">
              <UpdateSection status={status} progress={progress} releaseNotes={false} />
            </div>
          )}
        </div>
      </div>
    );
  } else if (loading || (notes === null && error === null)) {
    body = (
      <Centered>
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        <span>{t("releaseNotes.loading")}</span>
      </Centered>
    );
  } else if (error !== null) {
    body = (
      <Centered>
        <span>
          {error === "network"
            ? t("releaseNotes.failedNetwork")
            : error === "rate-limited"
              ? t("releaseNotes.failedRateLimited")
              : t("releaseNotes.failed")}
        </span>
        <Button variant="outline" size="sm" onClick={() => void loadReleaseNotes()}>
          {t("releaseNotes.retry")}
        </Button>
      </Centered>
    );
  } else {
    body = (
      <Centered>
        <span>{t("releaseNotes.empty")}</span>
      </Centered>
    );
  }

  return (
    <div className="absolute inset-0 z-(--layer-in-panel)">
      <div
        aria-hidden
        className="absolute inset-0 bg-[var(--floating-scrim)]"
        onMouseDown={(event) => {
          // The focus goes back where it was, not to the page.
          event.preventDefault();
          closeReleaseNotes();
        }}
        data-testid="release-notes-scrim"
      />
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("releaseNotes.title")}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        className="absolute inset-4 mx-auto flex max-w-[960px] flex-col overflow-hidden rounded-(--radius-island) border border-[var(--surface-floating-border)] bg-background outline-none"
        data-testid="release-notes"
      >
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
          <ScrollText className="size-4 text-muted-foreground" aria-hidden="true" />
          <span className="text-app-body-emphasis text-foreground">{t("releaseNotes.title")}</span>
          {loading && notes !== null && (
            <LoaderCircle
              className="size-3.5 animate-spin text-muted-foreground"
              aria-hidden="true"
            />
          )}
          <div className="flex-1" />
          {shown && (
            <Button variant="ghost" size="sm" onClick={() => openExternal(shown.url)}>
              <ExternalLink className="size-3.5" aria-hidden="true" />
              {t("releaseNotes.openOnGitHub")}
            </Button>
          )}
          <button
            type="button"
            className={icon}
            onClick={closeReleaseNotes}
            aria-label={t("releaseNotes.close")}
            title={t("releaseNotes.close")}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
        {body}
      </div>
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-app-ui-sm text-muted-foreground">
      {children}
    </div>
  );
}

function ReleaseList({
  notes,
  shown,
  current,
  locale,
}: {
  notes: readonly ReleaseNote[];
  shown: ReleaseNote;
  current: string;
  locale: string;
}) {
  const { t } = useTranslation();
  // The shown release stays in sight as ↑ ↓ move through the list, and
  // takes the focus there.
  const shownRef = useRef<HTMLButtonElement>(null);
  const shownVersion = shown.version;
  useEffect(() => {
    const button = shownRef.current;
    if (button?.dataset.version !== shownVersion) return;
    button.scrollIntoView({ block: "nearest" });
    if (button.closest("[data-release-list]")?.contains(document.activeElement)) button.focus();
  }, [shownVersion]);

  return (
    <nav
      aria-label={t("releaseNotes.versions")}
      className="flex w-60 shrink-0 flex-col border-r border-border"
    >
      <ul className="min-h-0 flex-1 overflow-y-auto p-2" data-release-list="">
        {notes.map((note) => {
          const mark = releaseMark(note, current);
          const selected = note === shown;
          return (
            <li key={note.version}>
              <button
                ref={selected ? shownRef : undefined}
                type="button"
                aria-current={selected ? "true" : undefined}
                data-version={note.version}
                onClick={() => useReleaseNotesStore.getState().select(note.version)}
                className={cn(
                  "flex w-full flex-col gap-0.5 rounded-(--radius-control) px-2.5 py-2 text-left",
                  selected
                    ? "bg-primary/15 ring-1 ring-primary/40 ring-inset"
                    : "hover:bg-[var(--state-hover-bg)]",
                )}
                data-testid="release-notes-version"
              >
                <span className="flex items-center gap-1.5">
                  <span className="text-app-body-emphasis text-foreground tabular-nums">
                    v{note.version}
                  </span>
                  {mark && <ReleaseMarkBadge mark={mark} />}
                  <span className="ml-auto text-app-micro text-muted-foreground">
                    {releaseDate(note.date, locale)}
                  </span>
                </span>
                {note.title && (
                  <span className="line-clamp-2 text-app-ui-sm text-muted-foreground">
                    {note.title}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        onClick={() => openExternal(allReleasesUrl(notes[0]?.url))}
        className="flex shrink-0 items-center gap-1.5 border-t border-border px-4 py-2.5 text-app-ui-sm text-muted-foreground hover:text-foreground"
      >
        <ExternalLink className="size-3.5" aria-hidden="true" />
        {t("releaseNotes.allReleases")}
      </button>
    </nav>
  );
}

function ReleaseMarkBadge({ mark }: { mark: "current" | "newer" | "prerelease" }) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        "rounded-full border px-1.5 text-app-micro leading-4",
        mark === "newer"
          ? "border-primary/40 bg-primary/15 text-(--state-info-fg)"
          : "border-border text-muted-foreground",
      )}
    >
      {t(`releaseNotes.${mark}`)}
    </span>
  );
}

/** Opens an outside link in the browser; main checks it is https. */
function openExternal(url: string): void {
  if (url.startsWith("https://")) void ipcCallResult("updates", "openReleasePage", { url });
}

/** The releases page, from a release's: ".../releases/tag/v1.0.0" is ".../releases". */
function allReleasesUrl(releaseUrl: string | undefined): string {
  return releaseUrl?.replace(/\/tag\/[^/]+$/, "") ?? "";
}

/**
 * Hands the notes, which are HTML, to the HTML step whole: a Markdown read
 * of them would end an HTML block at a blank line, as one in a code
 * sample, and read what follows as Markdown.
 */
function remarkWholeHtml() {
  return (tree: unknown, file: { value: unknown }) => {
    (tree as { children: unknown[] }).children = [{ type: "html", value: String(file.value) }];
  };
}

const MARKDOWN_COMPONENTS: React.ComponentProps<typeof ReactMarkdown>["components"] = {
  a({ href, children, node: _node, ...rest }) {
    const target = typeof href === "string" ? href : "";
    return (
      <a
        {...rest}
        href={target}
        onClick={(event) => {
          event.preventDefault();
          openExternal(target);
        }}
      >
        {children}
      </a>
    );
  },
};

/** No margin, padding or rule from the preview's styles. */
const FLAT = { margin: 0, padding: 0, border: 0 } as const;

function ReleaseBody({ note, locale }: { note: ReleaseNote; locale: string }) {
  // The notes take the keys the view has, so ↑ ↓ and Page Down scroll
  // them, once they show and when other notes replace them; the focus in
  // the list stays there.
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const body = bodyRef.current;
    const now = document.activeElement;
    if (body && (!now || now === document.body || now === body.closest('[role="dialog"]'))) {
      body.focus({ preventScroll: true });
    }
  }, []);

  return (
    <div
      ref={bodyRef}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the notes scroll by keyboard.
      tabIndex={0}
      className="md-preview min-h-0 flex-1 overflow-y-auto px-8 py-6 outline-none"
      data-release-body=""
      data-testid="release-notes-body"
    >
      <div>
        {/* Its own sizes, over the preview's heading and paragraph rules. */}
        <header className="mb-6 flex flex-col gap-1">
          <h1 style={{ ...FLAT, fontSize: 24 }} className="font-semibold text-foreground">
            v{note.version}
          </h1>
          {note.title && (
            <p style={FLAT} className="text-app-body text-foreground">
              {note.title}
            </p>
          )}
          <p style={FLAT} className="text-app-ui-sm text-muted-foreground">
            {releaseDate(note.date, locale)}
          </p>
        </header>
        <ReactMarkdown
          remarkPlugins={[remarkWholeHtml]}
          rehypePlugins={[rehypeRaw, rehypeSanitize]}
          components={MARKDOWN_COMPONENTS}
        >
          {note.html}
        </ReactMarkdown>
      </div>
    </div>
  );
}
