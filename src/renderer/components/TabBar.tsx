import type { Tab } from "../store/tabs";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface TabBarProps {
  tabs: Tab[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTerminalTab: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TabBar({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewTerminalTab,
}: TabBarProps) {
  return (
    <div className="tab-bar">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            role="tab"
            tabIndex={0}
            aria-selected={isActive}
            className={`tab-item${isActive ? " tab-item--active" : ""}`}
            onClick={() => onSelectTab(tab.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelectTab(tab.id);
              }
            }}
          >
            <span>{tab.title}</span>
            <button
              type="button"
              className="tab-item__close"
              onClick={(e) => {
                e.stopPropagation();
                onCloseTab(tab.id);
              }}
              title="Close tab"
            >
              x
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="tab-bar__add"
        onClick={onNewTerminalTab}
        title="New terminal tab"
      >
        +
      </button>
    </div>
  );
}
