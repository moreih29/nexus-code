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
          <DialogTitle>{workspaceName}에서 Claude Code hook을 활성화할까요?</DialogTitle>
          <DialogDescription>
            Nexus Code는 이 워크스페이스의 .claude/settings.local.json만 수정하고,
            해당 파일을 .gitignore에 추가하며, 기존 파일이 있으면 수정 전 1회 백업을 만듭니다.
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
          이 워크스페이스에서는 다시 묻지 않기
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
            나중에
          </Button>
          <Button
            type="button"
            onClick={() => {
              onApprove({ dontAskAgain });
              onOpenChange(false);
            }}
          >
            Hook 활성화
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
