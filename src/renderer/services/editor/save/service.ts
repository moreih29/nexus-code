import i18next from "i18next";
import type * as Monaco from "monaco-editor";
import { showConflictResolution } from "../../../components/editor/conflict-dialog";
import { showToast } from "../../../components/ui/toast";
import { ipcCallResult, unwrapIpcResult } from "../../../ipc/client";
import { fsErrorReason } from "../../../utils/file-error";
import { basename } from "../../../utils/path";
import {
  bytesToBase64,
  encodeText,
  encodingInfo,
  type TextEncoding,
} from "../encoding/text-encoding";
import { notifyDidSave } from "../lsp/bridge";
import {
  clearDiskDiverged,
  getResolvedModel,
  reloadModelFromDisk,
  setModelEncoding,
  syncLoadedValueAfterSave,
} from "../model/cache";
import {
  getDirtyEntry,
  markSaved as markDirtyTrackerSaved,
  updateLoadedMetadata,
} from "../model/dirty-tracker";
import { relPathForInput, setEncodingOverride } from "../model/file-loader";
import { promoteAllPreviewTabsForFile } from "../tabs/promote-policy";
import type { EditorInput } from "../types";
import { SaveSequentializer, SaveSupersededError } from "./sequentializer";

export function installEditorSaveAction(
  editor: Monaco.editor.IStandaloneCodeEditor,
  input: EditorInput,
): Monaco.IDisposable {
  const register = () =>
    editor.addAction({
      id: "nexus.file.save",
      label: i18next.t("settings:keybindings.command.file.save"),
      run: () => runSaveAndReport(input),
    });
  let action: Monaco.IDisposable | undefined = register();

  const refresh = () => {
    action?.dispose();
    action = register();
  };
  const release = () => {
    i18next.off("languageChanged", refresh);
    action?.dispose();
    action = undefined;
  };
  i18next.on("languageChanged", refresh);
  const editorLifetime = editor.onDidDispose(release);
  return {
    dispose() {
      editorLifetime.dispose();
      release();
    },
  };
}

export interface SaveOptions {
  encoding?: TextEncoding;
}

export type SaveResult =
  | { kind: "saved"; mtime: string; size: number }
  | { kind: "not-dirty" }
  | { kind: "no-model" }
  | { kind: "read-only" }
  | { kind: "conflict"; actual: { exists: false } | { exists: true; mtime: string; size: number } }
  | { kind: "superseded" }
  | { kind: "error"; message: string };

export function reportSaveFailure(result: SaveResult): void {
  if (result.kind === "error") {
    showToast({
      kind: "error",
      message: i18next.t("errors:save.failed", { reason: result.message }),
    });
  }
}

export async function saveModelInteractive(
  input: EditorInput,
  options: SaveOptions = {},
): Promise<SaveResult> {
  const result = await saveModel(input, options);

  if (result.kind !== "conflict") {
    return result;
  }

  const resolved = getResolvedModel(input);
  const filename = resolved ? basename(resolved.filePath) : basename(input.filePath);
  const choice = await showConflictResolution(filename);

  if (choice === "cancel") {
    return result;
  }

  if (choice === "reload") {
    let failure: SaveResult | undefined;
    const applied = await reloadModelFromDisk(input, undefined, (error) => {
      failure = { kind: "error", message: fsErrorReason(error) };
    });
    return failure ?? { kind: applied ? "not-dirty" : "superseded" };
  }

  const cacheUri = resolved?.cacheUri ?? "";
  const actual = result.actual;
  if (actual.exists) {
    updateLoadedMetadata(cacheUri, actual.mtime, actual.size);
  } else {
    updateLoadedMetadata(cacheUri, "", 0);
  }

  const retryResult = await saveModel(input, options);
  if (retryResult.kind === "saved") {
    clearDiskDiverged(input);
  }
  return retryResult;
}

export function runSaveAndReport(input: EditorInput): void {
  saveModelInteractive(input).then(reportSaveFailure, (error: unknown) => {
    showToast({
      kind: "error",
      message: i18next.t("errors:save.failed", { reason: fsErrorReason(error) }),
    });
  });
}

const sequentializer = new SaveSequentializer();

export async function saveModel(
  input: EditorInput,
  options: SaveOptions = {},
): Promise<SaveResult> {
  const initial = getResolvedModel(input);
  if (!initial) return { kind: "no-model" };

  if (initial.readOnly) {
    showToast({ kind: "info", message: i18next.t("errors:save.read_only") });
    return { kind: "read-only" };
  }

  promoteAllPreviewTabsForFile(initial.workspaceId, initial.filePath);

  const dirtyEntry = getDirtyEntry(initial.cacheUri);
  if (!dirtyEntry) return { kind: "no-model" };

  const force = options.encoding !== undefined;
  if (!dirtyEntry.isDirty && !force) return { kind: "not-dirty" };

  try {
    return await sequentializer.run(initial.cacheUri, async () => {
      const resolved = getResolvedModel(input);
      if (!resolved) return { kind: "no-model" } satisfies SaveResult;
      const dirtyEntryNow = getDirtyEntry(resolved.cacheUri);
      if (!dirtyEntryNow || (!dirtyEntryNow.isDirty && !force)) {
        return { kind: "not-dirty" } satisfies SaveResult;
      }

      const capturedAltId = resolved.model.getAlternativeVersionId();
      const content = resolved.model.getValue();
      const encoding = options.encoding ?? resolved.encoding;
      const written = contentToWrite(content, encoding);
      if (!written.ok) return { kind: "error", message: written.message } satisfies SaveResult;
      const expected =
        dirtyEntryNow.loadedMtime === ""
          ? ({ exists: false } as const)
          : ({
              exists: true,
              mtime: dirtyEntryNow.loadedMtime,
              size: dirtyEntryNow.loadedSize,
            } as const);

      const ipcResult = unwrapIpcResult(
        await ipcCallResult("fs", "writeFile", {
          workspaceId: resolved.workspaceId,
          relPath: relPathForInput({
            workspaceId: resolved.workspaceId,
            filePath: resolved.filePath,
          }),
          ...written.args,
          expected,
        }),
      );

      if (ipcResult.kind === "conflict") {
        return { kind: "conflict", actual: ipcResult.actual } satisfies SaveResult;
      }

      markDirtyTrackerSaved({
        cacheUri: resolved.cacheUri,
        model: resolved.model,
        savedAlternativeVersionId: capturedAltId,
        loadedMtime: ipcResult.mtime,
        loadedSize: ipcResult.size,
      });

      syncLoadedValueAfterSave(input, content);
      clearDiskDiverged(input);
      if (options.encoding !== undefined) {
        setEncodingOverride(input, options.encoding);
        setModelEncoding(input, options.encoding);
      }

      notifyDidSave(resolved.workspaceId, resolved.lspUri, content).catch(() => {});

      return { kind: "saved", mtime: ipcResult.mtime, size: ipcResult.size } satisfies SaveResult;
    });
  } catch (e) {
    if (e instanceof SaveSupersededError) {
      return { kind: "superseded" };
    }
    return { kind: "error", message: fsErrorReason(e) };
  }
}

function contentToWrite(
  content: string,
  encoding: TextEncoding,
): { ok: true; args: { content: string; bytes?: string } } | { ok: false; message: string } {
  if (encoding === "utf8") return { ok: true, args: { content } };
  if (encoding === "utf8-bom") return { ok: true, args: { content: `\ufeff${content}` } };
  const encoded = encodeText(content, encoding);
  if (!encoded.ok) {
    const { char, line, column } = encoded.unencodable;
    return {
      ok: false,
      message: i18next.t("errors:save.unencodable", {
        char,
        line,
        column,
        encoding: encodingInfo(encoding).name,
      }),
    };
  }
  return { ok: true, args: { content: "", bytes: bytesToBase64(encoded.bytes) } };
}
