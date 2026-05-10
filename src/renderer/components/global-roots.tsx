// Singleton mount roots — components that must be rendered exactly once
// at the App level, regardless of which workspace/group/tab is active.
//
// We collect them here so adding the next one (toast root, command
// palette, etc.) doesn't grow App.tsx. None of these compose props or
// listen for app-level state — they just need a fixed place in the
// React tree. A root may own one process-wide listener when the underlying
// feature must work independently of the active workspace panel.

import { WorkspaceSymbolPaletteRoot } from "./lsp/workspace-symbol/workspace-symbol-palette";
import { SaveConfirmDialogRoot } from "./ui/save-confirm-dialog";
import { ToastRoot } from "./ui/toast";
import { CloneDialogRoot } from "./files/git/CloneDialog";
import { CommitMessageDialog } from "./files/git/CommitMessageDialog";
import { CredentialPromptDialog } from "./files/git/CredentialPromptDialog";
import {
  type GitHelperPromptState,
  useGitHelperPrompts,
} from "./files/git/useGitHelperPrompts";
import { ViewParkRoot } from "./workspace/content/view-park";

export function GlobalRoots(): React.JSX.Element {
  return (
    <>
      <ViewParkRoot />
      <SaveConfirmDialogRoot />
      <WorkspaceSymbolPaletteRoot />
      <CloneDialogRoot />
      <GitHelperPromptsRoot />
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
