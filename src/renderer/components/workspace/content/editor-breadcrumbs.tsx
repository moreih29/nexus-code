// editor-breadcrumbs.tsx — Workspace-relative path breadcrumb shown on the
// left of the editor toolbar (paired with ViewModeToggle on the right).
//
// Layout strategy (mirrors VSCode / Cursor):
//   - Dir segments live in a flex container that can shrink and truncate
//     when the toolbar runs out of width.
//   - The filename segment is shrink-0 so it stays fully visible even as the
//     parent path collapses to ellipses.
//   - A single chevron separator sits between dir and filename so the visual
//     anchor never disappears.
//
// Files outside the workspace root fall through `relPath`'s absolute-path
// passthrough; we still render breadcrumbs but split on the absolute path —
// rare enough that bespoke handling isn't worth the branch.

import { ChevronRight } from "lucide-react";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { relPath } from "../../../utils/path";

interface EditorBreadcrumbsProps {
  filePath: string;
  workspaceRootAbsPath: string;
}

export function EditorBreadcrumbs({
  filePath,
  workspaceRootAbsPath,
}: EditorBreadcrumbsProps): React.JSX.Element | null {
  const { t } = useTranslation();
  if (!workspaceRootAbsPath) return null;

  const rel = relPath(filePath, workspaceRootAbsPath);
  const segments = rel.split("/").filter(Boolean);
  if (segments.length === 0) return null;

  const fileName = segments[segments.length - 1] ?? "";
  const dirSegments = segments.slice(0, -1);

  return (
    <nav
      aria-label={t("editor.file_path")}
      title={rel}
      className="flex items-center gap-1 min-w-0 text-app-ui-sm text-muted-foreground select-none"
    >
      {dirSegments.length > 0 && (
        <span className="flex items-center gap-1 min-w-0 overflow-hidden">
          {dirSegments.map((seg, i) => (
            <Fragment key={dirSegments.slice(0, i + 1).join("/")}>
              {i > 0 && (
                <ChevronRight className="size-3 shrink-0 opacity-60" aria-hidden="true" />
              )}
              <span className="truncate">{seg}</span>
            </Fragment>
          ))}
          <ChevronRight className="size-3 shrink-0 opacity-60" aria-hidden="true" />
        </span>
      )}
      <span className="shrink-0 text-foreground">{fileName}</span>
    </nav>
  );
}
