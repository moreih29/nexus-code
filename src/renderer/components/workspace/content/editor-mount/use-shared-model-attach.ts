import type * as Monaco from "monaco-editor";
import { type MutableRefObject, useCallback, useEffect, useRef } from "react";
import { applySharedModel } from "./apply-shared-model";

export interface UseSharedModelAttachOptions {
  editorRef: MutableRefObject<Monaco.editor.IStandaloneCodeEditor | null>;
  model: Monaco.editor.ITextModel | null;
  readOnly: boolean;
}

export interface UseSharedModelAttachResult {
  attach: (editor: Monaco.editor.IStandaloneCodeEditor) => void;
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

  useEffect(
    () => () => {
      temporaryModelRef.current = null;
    },
    [],
  );

  const rememberAsTemporary = useCallback((editor: Monaco.editor.IStandaloneCodeEditor): void => {
    temporaryModelRef.current = editor.getModel();
  }, []);

  return { attach, rememberAsTemporary };
}
