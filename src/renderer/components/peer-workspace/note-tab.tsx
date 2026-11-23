import { Tabs } from "radix-ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import type { PeerWorkspace } from "../../../shared/fs/peer-url";
import type { IpcResult } from "../../../shared/ipc/result";
import { noteTime } from "../../services/notes/note-time";
import { type PeerNoteTab, peerTabId } from "../../state/stores/peer-workspace";
import { cn } from "../../utils/cn";
import { REMARK_PLUGINS } from "../../utils/remark-plugins";
import { EmptyState } from "../ui/empty-state";
import { PeerReadOnlyBadge } from "./labels";
import { type PeerNote, readPeerNote } from "./notes-model";
import { peerSearchErrorKey } from "./search-model";

const WEB_LINK = /^https?:\/\//i;

const COMPONENTS: NonNullable<React.ComponentProps<typeof ReactMarkdown>["components"]> = {
  a({ href, children }) {
    const url = typeof href === "string" ? href : "";
    if (!WEB_LINK.test(url)) return <span title={url}>{children}</span>;
    return (
      <a
        href={url}
        title={url}
        onClick={(event) => {
          event.preventDefault();
          window.open(url, "_blank", "noopener,noreferrer");
        }}
      >
        {children}
      </a>
    );
  },
  img({ alt }) {
    return <span className="text-muted-foreground">[{alt || "image"}]</span>;
  },
  input({ type, checked }) {
    return type === "checkbox" ? (
      <input type="checkbox" checked={!!checked} disabled readOnly />
    ) : null;
  },
};

export function withoutHeading(markdown: string): string {
  return markdown.replace(/^# [^\n]*\n*/, "");
}

export function PeerNoteMarkdown({ source }: { source: string }) {
  return (
    <div className="md-preview">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={[rehypeHighlight]}
        components={COMPONENTS}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

export function PeerNoteTabBody({
  target,
  tab,
  selected,
  canRead,
  updateNeeded,
  rejoin,
}: {
  target: PeerWorkspace;
  tab: PeerNoteTab;
  selected: boolean;
  canRead: boolean;
  updateNeeded: boolean;
  rejoin: number;
}) {
  const { t } = useTranslation();
  const { deviceId, workspaceId } = target;
  const show = canRead && selected;
  const [result, setResult] = useState<IpcResult<PeerNote> | null>(null);
  const [note, setNote] = useState<PeerNote | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: read again on reconnect
  useEffect(() => {
    if (!show) return;
    const controller = new AbortController();
    const { signal } = controller;
    void readPeerNote({ deviceId, workspaceId }, tab.noteId, signal).then(
      (next) => {
        if (signal.aborted) return;
        setResult(next);
        if (next.ok) setNote(next.value);
        else if (next.kind === "not-found") setNote(null);
      },
      () => {},
    );
    return () => controller.abort();
  }, [show, rejoin, deviceId, workspaceId, tab.noteId]);

  const title = (note?.title ?? tab.title) || t("notes:panel.untitled");
  const error = updateNeeded
    ? t("peerWorkspace.updateNeeded")
    : note || !result || result.ok
      ? null
      : result.kind === "not-found"
        ? t("notes:editor.missing")
        : t(peerSearchErrorKey(result.kind));

  return (
    <Tabs.Content
      forceMount
      value={encodeURIComponent(peerTabId(tab))}
      className={cn("min-h-0 flex-1 flex-col", selected ? "flex" : "hidden")}
      data-testid="peer-note-tab"
    >
      <div className="flex shrink-0 flex-wrap items-start gap-2 border-b border-border px-6 pt-3 pb-2.5">
        <div className="flex min-w-48 flex-1 flex-col gap-0.5">
          <h2 className="truncate text-[17px] font-semibold text-foreground" title={title}>
            {title}
          </h2>
          {note && (
            <span className="truncate text-app-micro text-muted-foreground">
              {noteTime(note.updatedAt)}
            </span>
          )}
        </div>
        <PeerReadOnlyBadge />
      </div>
      {error || !note ? (
        <EmptyState
          title={error ?? t(show ? "notes:editor.loading" : "peerWorkspace.connectionUnavailable")}
          tone="status"
          className="flex-1"
        />
      ) : (
        <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-7 pt-4 pb-6">
          <PeerNoteMarkdown source={note.title ? withoutHeading(note.markdown) : note.markdown} />
          {note.transcript && (
            <section className="mt-6 border-t border-border pt-4">
              <h3 className="mb-2 text-app-body-emphasis">{t("notes:transcript.title")}</h3>
              <PeerNoteMarkdown source={withoutHeading(note.transcript)} />
            </section>
          )}
        </div>
      )}
    </Tabs.Content>
  );
}
