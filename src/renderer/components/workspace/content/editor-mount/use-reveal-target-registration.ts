import type * as Monaco from "monaco-editor";
import { useEffect } from "react";
import { registerRevealTarget } from "../../../../services/editor/tabs";

/**
 * Registers the live editor instance as the canonical reveal target for
 * `(workspaceId, filePath)` once both conditions hold:
 *
 *   - Monaco has fired onMount, so `editor` is the real `IStandaloneCodeEditor`
 *     (not null while the editor is still loading).
 *   - `ready` is true — i.e. the shared model is attached. Registering before
 *     model attachment would flush any queued reveal against the temporary
 *     empty model and silently lose the request.
 *
 * Why this hook exists separately from `useEditorMount`:
 *   The earlier broadcast-bus design had every previously-mounted EditorView
 *   subscribing to a global bus. With ContentHost keeping inactive editors
 *   alive in a view park (parked DOM, visibility:hidden), the FIRST claim of
 *   any reveal request was usually a parked editor — its `editor.focus()`
 *   silently no-ops and the visible editor never sees the reveal. Replacing
 *   that with a single-target registry per file makes the race structurally
 *   impossible. This hook is the per-mount half of that contract.
 */
export interface UseRevealTargetRegistrationOptions {
  workspaceId: string;
  filePath: string;
  editor: Monaco.editor.IStandaloneCodeEditor | null;
  ready: boolean;
}

export function useRevealTargetRegistration({
  workspaceId,
  filePath,
  editor,
  ready,
}: UseRevealTargetRegistrationOptions): void {
  useEffect(() => {
    if (!ready || !editor) return;
    return registerRevealTarget({ workspaceId, filePath }, editor);
  }, [ready, editor, workspaceId, filePath]);
}
