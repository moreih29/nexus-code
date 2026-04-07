export function StatusBar() {
  return (
    <div className="flex items-center px-3 h-7 bg-bg-surface border-t border-border text-xs text-text-muted select-none col-span-2">
      <span className="text-text-secondary">Nexus Code</span>
      <span className="mx-2 text-border">|</span>
      <span>준비</span>
    </div>
  )
}
