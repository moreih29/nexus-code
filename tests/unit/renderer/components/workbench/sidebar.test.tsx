import { beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";

const { Sidebar } = await import("../../../../../src/renderer/components/workbench/sidebar");
const { useUIStore } = await import("../../../../../src/renderer/state/stores/ui");
const { useWorkspacesStore } = await import("../../../../../src/renderer/state/stores/workspaces");

/**
 * Builds local or SSH workspace metadata for sidebar render tests.
 */
function makeWorkspace(meta: Partial<WorkspaceMeta> & Pick<WorkspaceMeta, "id" | "location">) {
  return {
    name: "workspace",
    rootPath: meta.location.kind === "local" ? meta.location.rootPath : meta.location.remotePath,
    colorTone: "default",
    pinned: false,
    lastOpenedAt: new Date().toISOString(),
    tabs: [],
    ...meta,
  } satisfies WorkspaceMeta;
}

/**
 * Resets the real stores used by the sidebar component.
 */
function resetStores(): void {
  useUIStore.setState({ sidebarWidth: 240 });
  useWorkspacesStore.setState({
    workspaces: [],
    connectionStatusByWorkspaceId: {},
  });
}

/**
 * Renders the sidebar with inert callbacks.
 */
function renderSidebar(workspaces: WorkspaceMeta[]): string {
  return renderToStaticMarkup(
    <Sidebar
      workspaces={workspaces}
      activeWorkspaceId={workspaces[0]?.id ?? null}
      onSelectWorkspace={() => {}}
      onAddWorkspace={() => {}}
      onRemoveWorkspace={() => {}}
    />,
  );
}

describe("Sidebar workspace rows", () => {
  beforeEach(resetStores);

  test("renders local Folder and ssh Server icons", () => {
    const html = renderSidebar([
      makeWorkspace({
        id: "123e4567-e89b-42d3-a456-426614174000",
        name: "local",
        location: { kind: "local", rootPath: "/tmp/project" },
      }),
      makeWorkspace({
        id: "123e4567-e89b-42d3-a456-426614174001",
        name: "remote",
        location: { kind: "ssh", host: "dev.example.com", remotePath: "/srv/project" },
      }),
    ]);

    expect(html).toContain("lucide-folder");
    expect(html).toContain("lucide-server");
  });

  test("renders ssh status aria label and remote path tooltip", () => {
    const workspaceId = "123e4567-e89b-42d3-a456-426614174002";

    const html = renderSidebar([
      makeWorkspace({
        id: workspaceId,
        name: "remote",
        location: {
          kind: "ssh",
          host: "dev.example.com",
          user: "deploy",
          remotePath: "/srv/project",
          configAlias: "devbox",
        },
      }),
    ]);

    expect(html).toContain('aria-label="SSH workspace, idle"');
    expect(html).toContain('title="/srv/project"');
    expect(html).toContain("devbox");
  });
});
