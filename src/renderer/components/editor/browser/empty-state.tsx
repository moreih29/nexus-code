/**
 * BrowserEmptyState — shown when the browser tab has no active URL.
 *
 * Displayed when `lastUrl` is empty (freshly created tab before any navigation).
 * Renders a centered Globe icon with instructional copy. The URL bar above
 * receives auto-focus so the user can type immediately.
 */
import { Globe } from "lucide-react";

export function BrowserEmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-5 py-8 text-center">
      <div className="text-muted-foreground">
        <Globe className="size-10" aria-hidden="true" />
      </div>
      <p className="text-app-ui-sm text-muted-foreground">Enter a URL or search</p>
    </div>
  );
}
