/**
 * Quick look over another computer's chat: a file its conversation names,
 * an image it has, or how a file it changed differs from the last commit,
 * read from that computer (files.read, chat.image, git.diff) and shown over
 * the conversation. Read only: the file stays there, and nothing here opens
 * it in an editor.
 */

import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { DiffHunk } from "../../../../packages/remote-protocol/src/rpc";
import { imageSrc } from "../../services/chat/image-look";
import type { ImageBlock } from "../../services/chat/model";
import { Highlighted, languageOf } from "../chat/code-highlight";
import { PatchView } from "../chat/tool-row";
import { IconButton } from "../ui/icon-button";

export type RemoteLookItem =
  | { kind: "loading"; title: string }
  | { kind: "image"; title: string; image: ImageBlock }
  | { kind: "text"; title: string; text: string; truncated: boolean; line?: number }
  | { kind: "diff"; title: string; hunks: readonly DiffHunk[] }
  | { kind: "message"; title: string; text: string };

export interface RemoteLookList {
  items: RemoteLookItem[];
  index: number;
}

export function RemoteLook({
  list,
  onStep,
  onClose,
}: {
  list: RemoteLookList;
  onStep: (index: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const item = list.items[list.index];
  const count = list.items.length;
  const step = (by: number) => {
    if (count > 1) onStep((list.index + by + count) % count);
  };
  // It takes the keyboard while open, and gives it back as it closes.
  useEffect(() => {
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus({ preventScroll: true });
    return () => {
      if (back?.isConnected) back.focus({ preventScroll: true });
    };
  }, []);
  // The line a link named comes into view.
  const line = item?.kind === "text" ? item.line : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once for each file shown
  useEffect(() => {
    if (!line) return;
    ref.current
      ?.querySelector(`[data-line="${line}"]`)
      ?.scrollIntoView({ block: "center", behavior: "instant" });
  }, [line, list.index, item?.kind]);
  if (!item) return null;

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-label={item.title}
      className="absolute inset-0 z-30 flex flex-col bg-background outline-none"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        } else if (event.key === "ArrowLeft" && count > 1) step(-1);
        else if (event.key === "ArrowRight" && count > 1) step(1);
      }}
      data-testid="remote-look"
    >
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-2">
        <span className="min-w-0 flex-1 truncate font-mono text-app-micro text-muted-foreground">
          {item.title}
        </span>
        {count > 1 && (
          <>
            <IconButton label={t("chat.look.previous")} size="xs" onClick={() => step(-1)}>
              <ChevronLeft className="size-3.5" />
            </IconButton>
            <span className="text-app-micro text-muted-foreground tabular-nums">
              {list.index + 1} / {count}
            </span>
            <IconButton label={t("chat.look.next")} size="xs" onClick={() => step(1)}>
              <ChevronRight className="size-3.5" />
            </IconButton>
          </>
        )}
        <IconButton label={t("chat.look.close")} size="xs" onClick={onClose}>
          <X className="size-3.5" />
        </IconButton>
      </div>
      <div className="app-scrollbar min-h-0 flex-1 overflow-auto">
        {item.kind === "loading" ? (
          <p className="m-auto p-6 text-center text-app-ui-sm text-muted-foreground">
            {t("agentView.remote.loading")}
          </p>
        ) : item.kind === "message" ? (
          <p className="p-6 text-center text-app-ui-sm text-muted-foreground">{item.text}</p>
        ) : item.kind === "image" ? (
          <div className="flex h-full items-center justify-center p-4">
            <img
              src={imageSrc(item.image)}
              alt={item.title}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        ) : item.kind === "diff" ? (
          <PatchView
            hunks={item.hunks}
            language={languageOf(item.title)}
            className="py-1 text-app-ui-sm"
          />
        ) : (
          <TextLines text={item.text} title={item.title} truncated={item.truncated} line={line} />
        )}
      </div>
    </div>
  );
}

/** A text file's lines, numbered, the one a link named marked. */
function TextLines({
  text,
  title,
  truncated,
  line,
}: {
  text: string;
  title: string;
  truncated: boolean;
  line?: number;
}) {
  const { t } = useTranslation();
  // A file's last newline ends its last line; it starts none.
  const lines = text.replace(/\r?\n$/, "").split("\n");
  const language = languageOf(title);
  return (
    <div className="code-hl flex min-w-max flex-col py-2 font-mono text-app-ui-sm">
      {lines.map((each, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: a file's lines, in order
          key={i}
          data-line={i + 1}
          className={
            line === i + 1 ? "flex bg-primary/10" : "flex hover:bg-[var(--state-hover-bg)]"
          }
        >
          <span className="w-12 shrink-0 select-none pr-3 text-right text-muted-foreground tabular-nums">
            {i + 1}
          </span>
          <span className="pr-4 whitespace-pre">
            <Highlighted code={each} language={language} />
          </span>
        </div>
      ))}
      {truncated && (
        <p className="px-3 pt-2 text-app-micro text-muted-foreground">
          {t("agentView.remote.fileTruncated")}
        </p>
      )}
    </div>
  );
}
