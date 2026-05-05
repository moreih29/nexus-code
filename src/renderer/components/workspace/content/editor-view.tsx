import Editor from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { type ReactNode, useCallback, useEffect, useRef } from "react";
import { fontFamily, typeScale } from "../../../../shared/design-tokens";
import { MAX_READABLE_FILE_SIZE } from "../../../../shared/fs-defaults";
import { saveModel, useSharedModel } from "../../../services/editor";
import { fileErrorMessage } from "../../../utils/file-error";

interface EditorViewProps {
  filePath: string;
  workspaceId: string;
}

const editorOptions = {
  minimap: { enabled: false },
  fontSize: typeScale.codeBody.fontSize,
  fontFamily: fontFamily.monoBody,
  scrollBeyondLastLine: false,
  automaticLayout: true,
} satisfies Monaco.editor.IStandaloneEditorConstructionOptions;

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 min-h-0 items-center justify-center text-app-ui-sm text-muted-foreground">
      {children}
    </div>
  );
}

export function EditorView({ filePath, workspaceId }: EditorViewProps) {
  const { model, phase, errorCode } = useSharedModel({ workspaceId, filePath });
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const temporaryModelRef = useRef<Monaco.editor.ITextModel | null>(null);

  const attachSharedModel = useCallback(
    (editor: Monaco.editor.IStandaloneCodeEditor): void => {
      if (!model) return;
      const currentModel = editor.getModel();
      if (currentModel === model) return;

      editor.setModel(model);

      const temporaryModel = temporaryModelRef.current;
      if (temporaryModel && temporaryModel !== model && !temporaryModel.isDisposed()) {
        temporaryModel.dispose();
      }
      temporaryModelRef.current = null;
    },
    [model],
  );

  useEffect(() => {
    const editor = editorRef.current;
    if (editor) attachSharedModel(editor);
  }, [attachSharedModel]);

  useEffect(
    () => () => {
      editorRef.current = null;
      temporaryModelRef.current = null;
    },
    [],
  );

  if (phase === "loading" || (phase === "ready" && !model)) {
    return <Centered>Loading...</Centered>;
  }

  if (phase === "binary") {
    return <Centered>Cannot display binary file.</Centered>;
  }

  if (phase === "error") {
    return (
      <Centered>
        {fileErrorMessage(errorCode ?? "OTHER", MAX_READABLE_FILE_SIZE / (1024 * 1024))}
      </Centered>
    );
  }

  return (
    <Editor
      height="100%"
      keepCurrentModel
      saveViewState={false}
      onMount={(editor, monaco) => {
        editorRef.current = editor;
        temporaryModelRef.current = editor.getModel();
        attachSharedModel(editor);

        // Cmd/Ctrl+S — registered on the editor instance so monaco's
        // built-in keybinding service handles it inside its textarea
        // (no double-fire with global handler). Reads the bound props
        // through closure: filePath/workspaceId stay current because
        // EditorView remounts on filePath change (key on filePath in
        // ContentHost).
        editor.addAction({
          id: "nexus.file.save",
          label: "Save File",
          keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
          run: () => {
            saveModel({ workspaceId, filePath }).catch(() => {
              // Errors are reported via SaveResult — promise rejection
              // here would be a programming error. Swallow to keep the
              // command from logging unhandled rejection noise.
            });
          },
        });
      }}
      theme="vs-dark"
      options={editorOptions}
    />
  );
}
