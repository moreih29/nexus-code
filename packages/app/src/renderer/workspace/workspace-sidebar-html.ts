import type { WorkspaceSidebarState } from "../../../../shared/src/contracts/workspace/workspace-shell";

export function renderWorkspaceSidebarHtml(sidebarState: WorkspaceSidebarState): string {
  const workspaceItemsHtml = sidebarState.openWorkspaces
    .map((workspace) => {
      const isActive = workspace.id === sidebarState.activeWorkspaceId;
      const activeAttribute = isActive ? "true" : "false";

      return [
        "<li>",
        `<button type="button" data-action="activate-workspace" data-workspace-id="${escapeHtmlAttribute(
          workspace.id,
        )}" data-active="${activeAttribute}" aria-current="${
          isActive ? "page" : "false"
        }">`,
        `<span>${escapeHtmlText(workspace.displayName)}</span>`,
        `<small>${escapeHtmlText(workspace.absolutePath)}</small>`,
        "</button>",
        "</li>",
      ].join("");
    })
    .join("");

  return [
    '<section data-component="workspace-sidebar">',
    "<header>",
    "<h2>Workspaces</h2>",
    '<button type="button" data-action="open-folder">Open Folder…</button>',
    "</header>",
    "<ol>",
    workspaceItemsHtml,
    "</ol>",
    "</section>",
  ].join("");
}

function escapeHtmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replaceAll('"', "&quot;");
}
