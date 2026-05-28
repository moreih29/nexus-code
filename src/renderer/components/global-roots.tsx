// Singleton mount roots — components that must be rendered exactly once
// at the App level, regardless of which workspace/group/tab is active.
//
// We collect them here so adding the next one (toast root, command
// palette, etc.) doesn't grow App.tsx. None of these compose props or
// listen for app-level state — they just need a fixed place in the
// React tree. A root may own one process-wide listener when the underlying
// feature must work independently of the active workspace panel.

import { ConflictResolutionDialogRoot } from "./editor/conflict-dialog";
import { SaveConfirmDialogRoot } from "./editor/save-confirm-dialog";
import { CommitMessageDialog } from "./files/git/commit/message-dialog";
import { CredentialPromptDialog } from "./files/git/dialogs/credential-prompt-dialog";
import {
  type GitHelperPromptState,
  useGitHelperPrompts,
} from "./files/git/hooks/use-helper-prompts";
import { WorkspaceSymbolPaletteRoot } from "./symbol-palette/workspace-symbol-palette";
import { ConfirmDialogRoot } from "./ui/confirm-dialog";
import { ToastRoot } from "./ui/toast";
import { ViewParkRoot } from "./workspace/content/view-park";
import { RemoveWorkspaceDialogRoot } from "./workspace/remove-workspace-dialog";
import { SshAuthPromptDialog } from "./workspace/ssh-auth-prompt-dialog";
import { useSshAuthPrompts } from "./workspace/use-ssh-auth-prompts";

export function GlobalRoots(): React.JSX.Element {
  return (
    <>
      <ViewParkRoot />
      <SaveConfirmDialogRoot />
      <ConfirmDialogRoot />
      <ConflictResolutionDialogRoot />
      <RemoveWorkspaceDialogRoot />
      <WorkspaceSymbolPaletteRoot />
      <GitHelperPromptsRoot />
      <SshAuthPromptsRoot />
      <ToastRoot />
    </>
  );
}

/**
 * Mounts Git askpass/editor helper prompts once at App level. Credential
 * prompts can fire before any Source Control panel exists, so the listener
 * cannot live inside GitPanel.
 */
export function GitHelperPromptsRoot(): React.JSX.Element {
  const helperPrompts = useGitHelperPrompts();
  return <GitHelperPromptDialogs {...helperPrompts} />;
}

/** Mounts remote SSH auth prompts once at App level for all workspaces. */
export function SshAuthPromptsRoot(): React.JSX.Element {
  const sshAuthPrompts = useSshAuthPrompts();
  return (
    <SshAuthPromptDialog
      prompt={sshAuthPrompts.currentPrompt}
      pendingMessage={sshAuthPrompts.pendingMessage}
      onCancel={sshAuthPrompts.cancelCurrent}
      onSubmitPassword={sshAuthPrompts.respondPassword}
      onTrustHostKey={sshAuthPrompts.trustHostKey}
    />
  );
}

/**
 * Renders the two helper prompt dialogs from the singleton prompt controller.
 */
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
