import Editor from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import type { ReactNode } from "react";
import { fontFamily, typeScale } from "../../../../shared/design-tokens/design-tokens";
import { MAX_READABLE_FILE_SIZE } from "../../../../shared/fs/fs-defaults";
import { ipcCall } from "../../../ipc/client";
import { useSharedModel } from "../../../services/editor";
import { NEXUS_DARK_THEME_NAME } from "../../../services/editor/runtime/monaco-theme";
import { fileErrorMessage } from "../../../utils/file-error";
import { ReadOnlyBanner } from "./read-only-banner";
import { useEditorMount } from "./use-editor-mount";

// Re-export for consumers (including drift-prone tests).
export { createCrossFileOpenCodeEditorOpener } from "../../../services/editor/tabs/cross-file-opener";

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
  const { model, phase, errorCode, readOnly } = useSharedModel({ workspaceId, filePath });

  const { onMount } = useEditorMount({
    filePath,
    workspaceId,
    model: model ?? null,
    readOnly,
    phase,
  });

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
    <div className="flex flex-col h-full">
      {readOnly && (
        <ReadOnlyBanner
          filePath={filePath}
          onRevealInFinder={() => {
            ipcCall("system", "revealInOS", { absPath: filePath }).catch(() => {});
          }}
        />
      )}
      <Editor
        height="100%"
        keepCurrentModel
        saveViewState={false}
        onMount={onMount}
        theme={NEXUS_DARK_THEME_NAME}
        options={editorOptions}
      />
    </div>
  );
}
