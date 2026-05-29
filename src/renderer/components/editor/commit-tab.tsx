import i18next from "i18next";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CommitDetail, CommitFileChange } from "../../../shared/git/types";
import { ipcCallResult, unwrapGitResult } from "../../ipc/client";
import { closeTab, openDiffTab } from "../../state/operations/tabs";
import { useTabsStore } from "../../state/stores/tabs";
import { Button } from "../ui/button";

const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

interface CommitTabProps {
  workspaceId: string;
  sha: string;
  tabId: string;
}

interface CommitTabError {
  message: string;
  notFound: boolean;
}

/**
 * Fetches and renders a Git commit as an editor-area tab.
 */
export function CommitTab({ workspaceId, sha, tabId }: CommitTabProps) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<CommitTabError | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    setError(null);
    setLoading(true);

    ipcCallResult("git", "commitDetail", { workspaceId, sha }, { signal: controller.signal })
      .then((ipcRes) => {
        if (controller.signal.aborted) return;
        // unwrapGitResult throws on git errors so the .catch handler below
        // receives the typed error with its `.kind` field intact.
        const nextDetail = unwrapGitResult(ipcRes);
        setDetail(nextDetail);
        // commit subject는 사용자 수동 rename이 아닌 자동 감지된 메타데이터이므로
        // setProcessTitle로 갱신. 사용자가 별도로 rename해두면 그 customTitle이 그대로 보존된다.
        useTabsStore.getState().setProcessTitle(workspaceId, tabId, nextDetail.subject);
      })
      .catch((fetchError) => {
        if (controller.signal.aborted) return;
        setError(commitTabErrorFrom(fetchError, sha));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [sha, tabId, workspaceId]);

  const openFileDiff = (file: CommitFileChange): void => {
    const leftRef = detail?.parents[0] ?? EMPTY_TREE_SHA;
    openDiffTab(workspaceId, file.path, leftRef, sha, file.oldPath);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border bg-muted px-4">
        <div className="min-w-0">
          <h2 className="truncate text-app-body-emphasis text-foreground">
            {detail?.subject ?? `commit ${sha.slice(0, 7)}`}
          </h2>
          <p className="truncate font-mono text-app-ui-sm text-muted-foreground">
            {detail?.sha ?? sha}
          </p>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto app-scrollbar p-4">
        {loading ? (
          <CenteredMessage>{t("editor.loading_commit")}</CenteredMessage>
        ) : error ? (
          <CommitErrorContent error={error} onClose={() => closeTab(workspaceId, tabId)} />
        ) : detail ? (
          <CommitDetailContent detail={detail} onFileClick={openFileDiff} />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Renders the metadata and changed file list for one commit.
 */
function CommitDetailContent({
  detail,
  onFileClick,
}: {
  detail: CommitDetail;
  onFileClick: (file: CommitFileChange) => void;
}) {
  const { t } = useTranslation();
  const isMerge = detail.parents.length > 1;

  return (
    <div className="flex flex-col gap-4 text-app-ui-sm">
      <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">{t("editor.author")}</dt>
        <dd className="min-w-0 truncate text-foreground">{detail.author}</dd>
        <dt className="text-muted-foreground">{t("editor.email")}</dt>
        <dd className="min-w-0 truncate text-foreground">{detail.authorEmail}</dd>
        <dt className="text-muted-foreground">{t("editor.time")}</dt>
        <dd className="min-w-0 truncate text-foreground">{formatIso(detail.committerTs)}</dd>
      </dl>
      {detail.body.length > 0 ? (
        <pre className="whitespace-pre-wrap rounded border border-border bg-muted p-2 font-sans text-app-ui-sm text-foreground">
          {detail.body}
        </pre>
      ) : null}
      {isMerge ? (
        <div className="rounded border border-border bg-muted p-2 text-muted-foreground">
          {t("editor.merge_commit", { count: detail.parents.length })}
        </div>
      ) : null}
      <div>
        <h4 className="mb-2 text-app-ui-sm text-muted-foreground">
          {t("editor.files_changed", { count: detail.files.length })}
        </h4>
        {detail.files.length === 0 ? (
          <p className="text-app-ui-sm text-muted-foreground">{t("editor.no_file_changes")}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {detail.files.map((file) => (
              <li key={`${file.status}:${file.oldPath ?? ""}:${file.path}`}>
                <button
                  type="button"
                  className="grid w-full grid-cols-[52px_minmax(0,1fr)] gap-2 rounded bg-muted px-2 py-1 text-left hover:bg-[var(--state-hover-bg)] focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-ring/50"
                  onClick={() => onFileClick(file)}
                >
                  <span className="font-mono text-muted-foreground">{file.status}</span>
                  <span className="min-w-0 truncate text-foreground" title={file.path}>
                    {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Renders the not-found close action or a generic commit-load error.
 */
function CommitErrorContent({ error, onClose }: { error: CommitTabError; onClose: () => void }) {
  const { t } = useTranslation();
  if (!error.notFound) {
    return <CenteredMessage>{error.message}</CenteredMessage>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 text-center text-app-ui-sm text-muted-foreground">
      <p>{error.message}</p>
      <Button type="button" variant="outline" size="sm" onClick={onClose}>
        {t("editor.close_tab")}
      </Button>
    </div>
  );
}

/**
 * Centers one tab-state message within the scroll body.
 */
function CenteredMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 items-center justify-center px-6 text-center text-app-ui-sm text-muted-foreground">
      {children}
    </div>
  );
}

/**
 * Formats the ISO timestamp shown in the detail metadata.
 */
function formatIso(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

/**
 * Converts IPC failures into commit-tab rendering state.
 */
function commitTabErrorFrom(error: unknown, sha: string): CommitTabError {
  const notFound = isCommitNotFoundError(error);
  return {
    notFound,
    message: notFound
      ? i18next.t("editor.commit_not_found", { sha: sha.slice(0, 7) })
      : error instanceof Error
        ? error.message
        : i18next.t("editor.commit_load_failed"),
  };
}

/**
 * Identifies ref-resolution failures produced by the git IPC layer.
 */
function isCommitNotFoundError(error: unknown): boolean {
  const kind = gitErrorKind(error);
  return kind === "ref-not-found" || kind === "missing" || kind === "no-such-ref";
}

/**
 * Reads the stable git error kind rehydrated by the renderer IPC layer.
 */
function gitErrorKind(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "kind" in error) {
    const kind = (error as { kind?: unknown }).kind;
    return typeof kind === "string" ? kind : null;
  }
  return null;
}
