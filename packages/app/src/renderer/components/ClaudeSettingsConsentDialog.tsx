import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

export interface ClaudeSettingsConsentDecision {
  dontAskAgain: boolean;
}

export interface ClaudeSettingsConsentDialogProps {
  open: boolean;
  workspaceName: string;
  dontAskAgain?: boolean;
  onOpenChange(open: boolean): void;
  onDontAskAgainChange?(checked: boolean): void;
  onApprove(decision: ClaudeSettingsConsentDecision): void;
  onCancel(): void;
}

export function ClaudeSettingsConsentDialog({
  open,
  workspaceName,
  dontAskAgain = false,
  onOpenChange,
  onDontAskAgainChange,
  onApprove,
  onCancel,
}: ClaudeSettingsConsentDialogProps): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Enable Claude Code hooks for {workspaceName}?</DialogTitle>
          <DialogDescription>
            Nexus Code will edit only this workspace&apos;s .claude/settings.local.json,
            add that file to .gitignore, and create a one-time backup before changing it.
          </DialogDescription>
        </DialogHeader>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={dontAskAgain}
            onChange={(event) => {
              onDontAskAgainChange?.(event.currentTarget.checked);
            }}
          />
          Don&apos;t ask again for this workspace
        </label>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              onCancel();
              onOpenChange(false);
            }}
          >
            Not now
          </Button>
          <Button
            type="button"
            onClick={() => {
              onApprove({ dontAskAgain });
              onOpenChange(false);
            }}
          >
            Enable hooks
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
