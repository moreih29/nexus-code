/**
 * Empty-workbench welcome affordances.
 */
import { openCloneDialog } from "../files/git/clone-dialog-state";
import { Button } from "../ui/button";

interface WelcomeScreenProps {
  readonly onOpenFolder: () => void;
}

/** Renders equal-weight entrypoints for opening an existing folder or cloning. */
export function WelcomeScreen({ onOpenFolder }: WelcomeScreenProps): React.JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <div>
          <h1 className="text-app-body-emphasis text-foreground">No workspace selected</h1>
          <p className="mt-2 text-app-ui-sm text-muted-foreground">
            Open a local folder or clone a repository to get started.
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onOpenFolder}>
            Open Folder…
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={openCloneDialog}>
            Clone Repository…
          </Button>
        </div>
      </div>
    </div>
  );
}
