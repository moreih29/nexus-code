/**
 * Empty-workbench welcome affordances.
 */
import { Button } from "../ui/button";

interface WelcomeScreenProps {
  readonly onAddWorkspace: () => void;
}

/** Renders the entrypoint for opening the Add-Workspace flow (local folder OR SSH). */
export function WelcomeScreen({ onAddWorkspace }: WelcomeScreenProps): React.JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <div>
          <h1 className="text-app-body-emphasis text-foreground">No workspace selected</h1>
          <p className="mt-2 text-app-ui-sm text-muted-foreground">
            Add a workspace to get started.
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onAddWorkspace}>
            Add workspace
          </Button>
        </div>
      </div>
    </div>
  );
}
