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
  harnessName?: string;
  settingsFiles?: readonly string[];
  settingsDescription?: string;
  gitignoreEntries?: readonly string[];
  dontAskAgain?: boolean;
  onOpenChange(open: boolean): void;
  onDontAskAgainChange?(checked: boolean): void;
  onApprove(decision: ClaudeSettingsConsentDecision): void;
  onCancel(): void;
}

export function ClaudeSettingsConsentDialog({
  open,
  workspaceName,
  harnessName = "Claude Code",
  settingsFiles = [".claude/settings.local.json"],
  settingsDescription,
  gitignoreEntries = [".claude/settings.local.json"],
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
          <DialogTitle>{workspaceName}에서 {harnessName} hook을 활성화할까요?</DialogTitle>
          <DialogDescription>
            {settingsDescription ??
              `Nexus Code는 이 워크스페이스의 ${settingsFiles.join(", ")}만 수정합니다.`}
            {" "}
            대상 파일: {settingsFiles.join(", ")}. .gitignore에는 {gitignoreEntries.join(", ")} 항목을 추가하고,
            기존 파일이 있으면 수정 전 1회 백업을 만듭니다.
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
