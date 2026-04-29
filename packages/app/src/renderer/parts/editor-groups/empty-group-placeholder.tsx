export interface EmptyGroupPlaceholderGroup {
  tabs: readonly unknown[];
}

export function EmptyGroupPlaceholder(): JSX.Element {
  return (
    <div
      role="status"
      aria-label="Empty editor group"
      data-editor-empty-group-placeholder="true"
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-6 text-center text-muted-foreground"
    >
      <div className="max-w-xs">
        <p className="text-sm font-medium text-muted-foreground">No editor open</p>
        <p className="mt-1 text-xs leading-normal text-muted-foreground/80">
          Open a file from Explorer to start editing.
        </p>
      </div>
    </div>
  );
}

export function shouldShowEmptyGroupPlaceholder(groups: readonly EmptyGroupPlaceholderGroup[]): boolean {
  return groups.length === 1 && groups[0]?.tabs.length === 0;
}
