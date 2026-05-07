import Editor from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { type ReactNode, useCallback, useEffect, useRef } from "react";
import { fontFamily, typeScale } from "../../../../shared/design-tokens";
import { MAX_READABLE_FILE_SIZE } from "../../../../shared/fs-defaults";
import type { MonacoRange } from "../../../../shared/monaco-range";
import {
  cacheUriToFilePath,
  openOrRevealEditor,
  saveModel,
  useSharedModel,
} from "../../../services/editor";
import { NEXUS_DARK_THEME_NAME } from "../../../services/editor/monaco-theme";
import {
  subscribePendingEditorReveal,
  takePendingEditorReveal,
} from "../../../services/editor/pending-reveal";
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

interface ResourceUriLike {
  toString(): string;
}

interface CrossFileOpenCodeEditorOpener {
  openCodeEditor(source: unknown, resource: ResourceUriLike): boolean;
}

interface CreateCrossFileOpenCodeEditorOpenerInput {
  getWorkspaceId: () => string;
  sourceEditor: unknown;
  openEditor?: (input: { workspaceId: string; filePath: string }) => unknown;
  uriToFilePath?: (cacheUri: string) => string | null;
}

function resourceToString(resource: ResourceUriLike): string | null {
  try {
    return resource.toString();
  } catch {
    return null;
  }
}

function sourceModelUri(source: unknown): string | null {
  if (typeof source !== "object" || source === null || !("getModel" in source)) {
    return null;
  }

  const getModel = source.getModel;
  if (typeof getModel !== "function") return null;

  const model = getModel.call(source) as unknown;
  if (typeof model !== "object" || model === null || !("uri" in model)) {
    return null;
  }

  const uri = (model as { uri?: unknown }).uri;
  if (typeof uri !== "object" || uri === null || !("toString" in uri)) {
    return null;
  }

  const uriToString = uri.toString;
  if (typeof uriToString !== "function") return null;

  try {
    return uriToString.call(uri);
  } catch {
    return null;
  }
}

export function createCrossFileOpenCodeEditorOpener({
  getWorkspaceId,
  sourceEditor,
  openEditor = openOrRevealEditor,
  uriToFilePath = cacheUriToFilePath,
}: CreateCrossFileOpenCodeEditorOpenerInput): CrossFileOpenCodeEditorOpener {
  return {
    openCodeEditor(source, resource) {
      if (source !== sourceEditor) return false;

      const resourceUri = resourceToString(resource);
      if (!resourceUri) return false;

      if (sourceModelUri(source) === resourceUri) return false;

      const filePath = uriToFilePath(resourceUri);
      if (filePath === null) return false;

      openEditor({ workspaceId: getWorkspaceId(), filePath });
      return true;
    },
  };
}

function revealRange(editor: Monaco.editor.IStandaloneCodeEditor, range: MonacoRange): void {
  editor.setSelection(range);
  editor.revealRangeInCenter(range);
}

function applyPendingReveal(
  editor: Monaco.editor.IStandaloneCodeEditor,
  workspaceId: string,
  filePath: string,
): void {
  const range = takePendingEditorReveal({ workspaceId, filePath });
  if (!range) return;
  revealRange(editor, range);
}

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
  const openerDisposableRef = useRef<Monaco.IDisposable | null>(null);
  const workspaceIdRef = useRef(workspaceId);
  const temporaryModelRef = useRef<Monaco.editor.ITextModel | null>(null);
  workspaceIdRef.current = workspaceId;

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

  useEffect(() => {
    if (phase !== "ready") return;
    const editor = editorRef.current;
    if (!editor) return;

    applyPendingReveal(editor, workspaceId, filePath);
    return subscribePendingEditorReveal((pending) => {
      if (pending.workspaceId !== workspaceId || pending.filePath !== filePath) return;
      const currentEditor = editorRef.current;
      if (!currentEditor) return;
      applyPendingReveal(currentEditor, workspaceId, filePath);
    });
  }, [phase, workspaceId, filePath]);

  useEffect(
    () => () => {
      openerDisposableRef.current?.dispose();
      openerDisposableRef.current = null;
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
        applyPendingReveal(editor, workspaceId, filePath);

        openerDisposableRef.current?.dispose();
        const openCodeEditorOpener = createCrossFileOpenCodeEditorOpener({
          getWorkspaceId: () => workspaceIdRef.current,
          sourceEditor: editor,
        });
        openerDisposableRef.current = monaco.editor.registerEditorOpener({
          openCodeEditor: (source: Monaco.editor.ICodeEditor, resource: Monaco.Uri) =>
            openCodeEditorOpener.openCodeEditor(source, resource),
        });

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
      theme={NEXUS_DARK_THEME_NAME}
      options={editorOptions}
    />
  );
}
