// What an app command shows above the composer: /btw's answer, /help's
// list, /memory's files, /tasks' sessions. One at a time; the next command
// replaces it.

import { FileText, LoaderCircle, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CommandCard } from "../../services/chat/store";
import { IconButton } from "../ui/icon-button";
import { useChatLinks } from "./chat-links";
import { ChatMarkdown } from "./chat-markdown";

export function CommandCardView({
  card,
  workspaceId,
  cwd,
  rootPath,
  onClose,
}: {
  card: CommandCard;
  workspaceId: string;
  cwd: string;
  rootPath: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const links = useChatLinks();
  return (
    <section
      className="flex max-h-72 flex-col rounded-(--radius-control) border border-border bg-muted/40"
      aria-label={card.title}
      data-testid="chat-command-card"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1">
        <span className="min-w-0 flex-1 truncate font-mono text-app-micro text-muted-foreground">
          {card.title}
        </span>
        <IconButton label={t("chat.commands.close")} size="xs" onClick={onClose}>
          <X className="size-3.5" />
        </IconButton>
      </header>
      <div className="app-scrollbar min-h-0 overflow-y-auto px-3 py-2 text-app-body">
        {card.loading && (
          <div className="flex items-center gap-2 text-app-ui-sm text-muted-foreground">
            <LoaderCircle className="size-3.5 animate-spin" />
            {t("chat.commands.working")}
          </div>
        )}
        {card.error && (
          <div className="text-app-ui-sm text-[var(--state-error-fg)]">{card.error}</div>
        )}
        {card.text && (
          <ChatMarkdown text={card.text} workspaceId={workspaceId} cwd={cwd} rootPath={rootPath} />
        )}
        {card.files && card.files.length > 0 && (
          <ul className="flex flex-col">
            {card.files.map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  onClick={() => links?.openFileTab(file.path)}
                  className="flex w-full items-center gap-2 rounded-(--radius-control) px-1 py-1 text-left text-app-ui-sm hover:bg-[var(--state-hover-bg)]"
                  title={file.path}
                >
                  <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{file.label}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {card.sections?.map((section) => (
          <div key={section.title} className="mt-1 first:mt-0">
            <div className="px-1 py-1 text-app-micro font-medium text-muted-foreground">
              {section.title}
            </div>
            {section.rows.length === 0 ? (
              <div className="px-1 pb-1 text-app-ui-sm text-muted-foreground">{section.empty}</div>
            ) : (
              <ul className="flex flex-col">
                {section.rows.map((row) => (
                  <li
                    key={row.id}
                    className="flex min-w-0 items-center gap-2 rounded-(--radius-control) px-1 py-0.5 text-app-ui-sm hover:bg-[var(--state-hover-bg)]"
                  >
                    <span className="min-w-0 flex-1 truncate" title={row.label}>
                      {row.label}
                    </span>
                    {row.detail && (
                      <span className="shrink-0 text-muted-foreground">{row.detail}</span>
                    )}
                    {row.actions.map((action) => (
                      <button
                        key={action.label}
                        type="button"
                        onClick={action.run}
                        className="shrink-0 rounded-(--radius-control) px-1.5 py-0.5 text-app-micro text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground"
                      >
                        {action.label}
                      </button>
                    ))}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
