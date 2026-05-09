import type * as Monaco from "monaco-editor";
import { type MutableRefObject, useCallback, useEffect, useRef } from "react";
import { applySharedModel } from "./apply-shared-model";

/**
 * Owns the shared-model attachment lifecycle for a single editor instance:
 *
 *   - The first onMount call hands us the editor's *temporary* model
 *     (the empty model Monaco creates at construction time). We remember
 *     it so `applySharedModel` can dispose it once the real model is
 *     swapped in — otherwise the temp model leaks.
 *   - `attach` runs `applySharedModel`. It is intended to be called both
 *     from onMount (with the just-attached editor) and from the effect
 *     below whenever `model` or `readOnly` change after mount.
 *   - The effect re-runs `attach` against the current editor whenever the
 *     model identity flips (cache-miss → real load) or the readOnly flag
 *     changes — Monaco only invokes onMount once per editor instance, so
 *     post-mount model swaps must go through this side channel.
 */
export interface UseSharedModelAttachOptions {
  editorRef: MutableRefObject<Monaco.editor.IStandaloneCodeEditor | null>;
  model: Monaco.editor.ITextModel | null;
  readOnly: boolean;
}

export interface UseSharedModelAttachResult {
  /** Apply the shared model + readOnly to the given editor. */
  attach: (editor: Monaco.editor.IStandaloneCodeEditor) => void;
  /**
   * Remember the editor's current model as the temporary one. Call this
   * inside onMount before `attach`, so a later swap to the real shared
   * model can dispose the temp.
   */
  rememberAsTemporary: (editor: Monaco.editor.IStandaloneCodeEditor) => void;
}

export function useSharedModelAttach({
  editorRef,
  model,
  readOnly,
}: UseSharedModelAttachOptions): UseSharedModelAttachResult {
  const temporaryModelRef = useRef<Monaco.editor.ITextModel | null>(null);

  const attach = useCallback(
    (editor: Monaco.editor.IStandaloneCodeEditor): void => {
      applySharedModel(editor, model, readOnly, temporaryModelRef);
    },
    [model, readOnly],
  );

  useEffect(() => {
    const editor = editorRef.current;
    if (editor) attach(editor);
  }, [attach, editorRef]);

  // Drop the temp-model handle on unmount so a stale ref can't keep the
  // disposed model alive.
  useEffect(
    () => () => {
      temporaryModelRef.current = null;
    },
    [],
  );

  const rememberAsTemporary = useCallback(
    (editor: Monaco.editor.IStandaloneCodeEditor): void => {
      temporaryModelRef.current = editor.getModel();
    },
    [],
  );

  return { attach, rememberAsTemporary };
}
