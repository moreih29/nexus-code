// Singleton mount roots — components that must be rendered exactly once
// at the App level, regardless of which workspace/group/tab is active.
//
// We collect them here so adding the next one (toast root, command
// palette, etc.) doesn't grow App.tsx. None of these compose props or
// listen for app-level state — they just need a fixed place in the
// React tree. A root may own one process-wide listener when the underlying
// feature must work independently of the active workspace panel.

import { CloneDialogRoot } from "./files/git/clone/CloneDialog";
import { CommitMessageDialog } from "./files/git/commit/CommitMessageDialog";
import { CredentialPromptDialog } from "./files/git/clone/CredentialPromptDialog";
import { type GitHelperPromptState, useGitHelperPrompts } from "./files/git/hooks/use-git-helper-prompts";
import { WorkspaceSymbolPaletteRoot } from "./lsp/workspace-symbol/workspace-symbol-palette";
import { SaveConfirmDialogRoot } from "./ui/save-confirm-dialog";
import { ToastRoot } from "./ui/toast";
import { SshAuthPromptDialog } from "./workspace/SshAuthPromptDialog";
import { ViewParkRoot } from "./workspace/content/view-park";
import { useSshAuthPrompts } from "./workspace/useSshAuthPrompts";

export function GlobalRoots(): React.JSX.Element {
  return (
    <>
      <ViewParkRoot />
      <SaveConfirmDialogRoot />
      <WorkspaceSymbolPaletteRoot />
      <CloneDialogRoot />
      <GitHelperPromptsRoot />
      <SshAuthPromptsRoot />
      <ToastRoot />
    </>
  );
}

/**
 * Mounts Git askpass/editor helper prompts once at App level. Clone can run
 * before any Source Control panel exists, so the listener cannot live inside
 * GitPanel.
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
