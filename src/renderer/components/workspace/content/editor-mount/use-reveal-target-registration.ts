import type * as Monaco from "monaco-editor";
import { useEffect } from "react";
import { registerRevealTarget } from "../../../../services/editor/tabs";
import { registerTabFocusTarget } from "../../../../services/tab-focus";

export interface UseRevealTargetRegistrationOptions {
  workspaceId: string;
  filePath: string;
  tabId: string;
  editor: Monaco.editor.IStandaloneCodeEditor | null;
  ready: boolean;
}

export function useRevealTargetRegistration({
  workspaceId,
  filePath,
  tabId,
  editor,
  ready,
}: UseRevealTargetRegistrationOptions): void {
  useEffect(() => {
    if (!ready || !editor) return;
    return registerRevealTarget({ workspaceId, filePath }, editor, tabId);
  }, [ready, editor, workspaceId, filePath, tabId]);

  useEffect(() => {
    if (!ready || !editor) return;
    return registerTabFocusTarget(tabId, () => editor.focus());
  }, [ready, editor, tabId]);
}
