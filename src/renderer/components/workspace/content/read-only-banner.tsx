interface ReadOnlyBannerProps {
  filePath: string;
  onRevealInFinder?: () => void;
}

export function ReadOnlyBanner({ onRevealInFinder }: ReadOnlyBannerProps) {
  return (
    <div className="flex items-center justify-between shrink-0 h-6 px-3 bg-frosted-veil border-b border-mist-border text-app-ui-xs text-muted-foreground">
      <span>Read-only — definition from external source</span>
      {onRevealInFinder && (
        <button
          type="button"
          className="text-app-ui-xs text-muted-foreground hover:text-foreground cursor-pointer bg-transparent border-0 p-0"
          onClick={onRevealInFinder}
        >
          Reveal in Finder
        </button>
      )}
    </div>
  );
}
