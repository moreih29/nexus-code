import type { WorkspaceMeta } from "../../shared/types/workspace";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SidebarProps {
  workspaces: WorkspaceMeta[];
  activeWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Sidebar({ workspaces, activeWorkspaceId, onSelectWorkspace }: SidebarProps) {
  return (
    <aside className="app-sidebar">
      <div style={{ padding: "12px 0" }}>
        {workspaces.map((ws) => {
          const isActive = ws.id === activeWorkspaceId;
          const pathTail = ws.rootPath.split("/").filter(Boolean).slice(-2).join("/");

          return (
            <div
              key={ws.id}
              className={`workspace-item${isActive ? " workspace-item--active" : ""}`}
              onClick={() => onSelectWorkspace(ws.id)}
              style={{
                padding: "8px 16px",
                cursor: "pointer",
                borderRadius: "6px",
                margin: "2px 8px",
                userSelect: "none",
              }}
            >
              {/* Category label — uppercase Caption */}
              {ws.category && (
                <div
                  style={{
                    fontSize: "11px",
                    fontWeight: 400,
                    letterSpacing: "1.4px",
                    textTransform: "uppercase",
                    color: "var(--color-text-muted)",
                    lineHeight: 1,
                    marginBottom: "3px",
                  }}
                >
                  {ws.category}
                </div>
              )}
              {/* Workspace name — Body Large */}
              <div
                style={{
                  fontSize: "14px",
                  fontWeight: 400,
                  letterSpacing: "-0.14px",
                  lineHeight: 1.4,
                  color: isActive ? "var(--color-text-primary)" : "var(--color-text-secondary)",
                }}
              >
                {ws.name}
              </div>
              {/* Path tail — Micro */}
              <div
                style={{
                  fontSize: "11px",
                  fontWeight: 400,
                  letterSpacing: 0,
                  lineHeight: 1.2,
                  color: "var(--color-text-muted)",
                  marginTop: "2px",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {pathTail}
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
