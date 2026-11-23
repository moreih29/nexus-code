import { fileKind, resolveFilePath } from "../../services/chat/links";
import type { ToolCall } from "../../services/chat/model";
import { sentFilesOf } from "../../services/chat/panel";
import { FileCard } from "./answer-extras";
import { FileImage, ImageChip } from "./file-image";

export function SentFiles({
  tool,
  workspaceId,
  cwd,
  shownEarlier,
}: {
  tool: ToolCall;
  workspaceId: string;
  cwd: string;
  shownEarlier?: ReadonlySet<string>;
}) {
  const files = sentFilesOf(tool).flatMap((file) => resolveFilePath(file, cwd) ?? []);
  const caption = (tool.input as { caption?: unknown } | null)?.caption;
  return (
    <div className="my-1.5 flex flex-col gap-1.5" data-testid="chat-sent-files">
      {typeof caption === "string" && caption !== "" && (
        <p className="text-app-ui-sm text-muted-foreground">{caption}</p>
      )}
      <div className="flex flex-wrap items-start gap-2">
        {files.map((path) => {
          const card = <FileCard key={path} path={path} workspaceId={workspaceId} cwd={cwd} />;
          if (fileKind(path) === "image" && shownEarlier?.has(path)) {
            return <ImageChip key={path} path={path} />;
          }
          return fileKind(path) === "image" ? (
            <FileImage
              key={path}
              path={path}
              workspaceId={workspaceId}
              alt={path}
              fallback={card}
            />
          ) : (
            card
          );
        })}
      </div>
    </div>
  );
}
