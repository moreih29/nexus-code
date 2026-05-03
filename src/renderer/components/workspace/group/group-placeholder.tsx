export function GroupPlaceholder() {
  return (
    <div className="absolute inset-0 flex flex-col items-center pt-12 gap-1 pointer-events-none select-none">
      <span className="text-app-ui-sm text-stone-gray">No tab open</span>
      <span className="text-app-ui-xs text-muted-foreground">⌘E New Terminal</span>
      <span className="text-app-ui-xs text-muted-foreground">⌘↵ Open file in split</span>
    </div>
  );
}
