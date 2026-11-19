import { expect, mock, test } from "bun:test";
import i18next from "i18next";
import type * as Monaco from "monaco-editor";
import { installEditorSaveAction } from "../../../../../src/renderer/services/editor/save/service";
import { createI18n } from "../../../../../src/shared/i18n";

test("the editor save action follows the palette language on an open editor", async () => {
  const originalLanguage = i18next.language;
  await i18next.init(createI18n({ lng: "ko" }).options);
  const dispose = mock(() => {});
  const labels: string[] = [];
  const editor = {
    addAction(action: Monaco.editor.IActionDescriptor) {
      labels.push(action.label);
      return { dispose };
    },
    onDidDispose() {
      return { dispose() {} };
    },
  } as unknown as Monaco.editor.IStandaloneCodeEditor;
  const installed = installEditorSaveAction(editor, { workspaceId: "ws", filePath: "/file" });
  try {
    expect(labels).toEqual(["파일 저장"]);
    await i18next.changeLanguage("en");
    expect(labels).toEqual(["파일 저장", "Save File"]);
    expect(dispose).toHaveBeenCalledTimes(1);
  } finally {
    installed.dispose();
    await i18next.changeLanguage(originalLanguage ?? "en");
  }
  expect(labels).toHaveLength(2);
});
