import { Banner } from "../../ui/banner";

interface ReadOnlyBannerProps {
  filePath: string;
  onRevealInFinder?: () => void;
}

export function ReadOnlyBanner({ onRevealInFinder }: ReadOnlyBannerProps) {
  return (
    <Banner
      display="bar"
      variant="info"
      message="Read-only — definition from external source"
      actions={
        onRevealInFinder ? [{ label: "Reveal in Finder", onAction: onRevealInFinder }] : []
      }
      role="status"
    />
  );
}
