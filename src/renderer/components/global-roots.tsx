import { memo } from "react";
import { LinkMenuRoot } from "./chat/chat-links";
import { CliConsentDialogRoot } from "./cli/consent-dialog";
import { ConflictResolutionDialogRoot } from "./editor/conflict-dialog";
import { SaveConfirmDialogRoot } from "./editor/save-confirm-dialog";
import { CommitMessageDialog } from "./files/git/commit/message-dialog";
import { CredentialPromptDialog } from "./files/git/dialogs/credential-prompt-dialog";
import {
  type GitHelperPromptState,
  useGitHelperPrompts,
} from "./files/git/hooks/use-helper-prompts";
import { KeychainRoot } from "./keychain/keychain-root";
import { NoteSummaryNotifications } from "./notes/summary-notifications";
import { WorkspaceSymbolPaletteRoot } from "./symbol-palette/workspace-symbol-palette";
import { ConfirmDialogRoot } from "./ui/confirm-dialog";
import { PermissionPromptRoot } from "./ui/permission-prompt-dialog";
import { ToastRoot } from "./ui/toast";
import { TooltipRoot } from "./ui/tooltip";
import { LspLogDialogRoot } from "./workbench/lsp-log-dialog";
import { ViewParkRoot } from "./workspace/content/view-park";
import { NewTaskDialogRoot } from "./workspace/new-task-dialog";
import { RemoveTaskDialogRoot } from "./workspace/remove-task-dialog";
import { RemoveWorkspaceDialogRoot } from "./workspace/remove-workspace-dialog";
import { SshAuthPromptDialog } from "./workspace/ssh-auth-prompt-dialog";
import { useSshAuthPrompts } from "./workspace/use-ssh-auth-prompts";

export const GlobalRoots = memo(function GlobalRoots(): React.JSX.Element {
  return (
    <>
      <ViewParkRoot />
      <SaveConfirmDialogRoot />
      <ConfirmDialogRoot />
      <CliConsentDialogRoot />
      <PermissionPromptRoot />
      <ConflictResolutionDialogRoot />
      <RemoveWorkspaceDialogRoot />
      <NewTaskDialogRoot />
      <RemoveTaskDialogRoot />
      <WorkspaceSymbolPaletteRoot />
      <GitHelperPromptsRoot />
      <SshAuthPromptsRoot />
      <LspLogDialogRoot />
      <ToastRoot />
      <KeychainRoot />
      <NoteSummaryNotifications />
      <TooltipRoot />
      <LinkMenuRoot />
    </>
  );
});

export function GitHelperPromptsRoot(): React.JSX.Element {
  const helperPrompts = useGitHelperPrompts();
  return <GitHelperPromptDialogs {...helperPrompts} />;
}

export function SshAuthPromptsRoot(): React.JSX.Element {
  const sshAuthPrompts = useSshAuthPrompts();
  return (
    <SshAuthPromptDialog
      prompt={sshAuthPrompts.currentPrompt}
      pendingMessage={sshAuthPrompts.pendingMessage}
      isReattach={sshAuthPrompts.isReattach}
      onCancel={sshAuthPrompts.cancelCurrent}
      onSubmitPassword={sshAuthPrompts.respondPassword}
      onTrustHostKey={sshAuthPrompts.trustHostKey}
    />
  );
}

export function GitHelperPromptDialogs({
  credentialPrompt,
  editorPrompt,
  cancelCredential,
  respondCredential,
  cancelCommitMessage,
  saveCommitMessage,
}: GitHelperPromptState): React.JSX.Element {
  return (
    <>
      <CredentialPromptDialog
        prompt={credentialPrompt}
        onCancel={cancelCredential}
        onSubmit={respondCredential}
      />
      <CommitMessageDialog
        prompt={editorPrompt}
        onCancel={cancelCommitMessage}
        onSave={saveCommitMessage}
      />
    </>
  );
}
