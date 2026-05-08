import { describe, expect, mock, test } from "bun:test";
import type * as Monaco from "monaco-editor";
import {
  installEditorOpener,
  installLocationModelPreAcquire,
  installMonacoCompensations,
  type MonacoCompensationInstaller,
} from "../../../../../src/renderer/services/editor/runtime/monaco-compensations";

function installer(name: string, events: string[]): MonacoCompensationInstaller {
  return () => {
    events.push(`install:${name}`);
    return { dispose: () => events.push(`dispose:${name}`) };
  };
}

describe("monaco compensations facade", () => {
  test("composes injected installers in order and disposes them in reverse", () => {
    const events: string[] = [];
    const disposable = installMonacoCompensations({} as typeof Monaco, {
      installers: [installer("a", events), installer("b", events)],
    });

    expect(events).toEqual(["install:a", "install:b"]);

    disposable.dispose();

    expect(events).toEqual(["install:a", "install:b", "dispose:b", "dispose:a"]);
  });

  test("installEditorOpener delegates to monaco registerEditorOpener", () => {
    const dispose = mock(() => {});
    const registerEditorOpener = mock((_opener: Monaco.editor.ICodeEditorOpener) => ({ dispose }));
    const monaco = { editor: { registerEditorOpener } } as unknown as typeof Monaco;
    const opener = { openCodeEditor: mock(() => true) } as Monaco.editor.ICodeEditorOpener;

    const disposable = installEditorOpener(monaco, opener);

    expect(registerEditorOpener).toHaveBeenCalledWith(opener);
    disposable.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("installLocationModelPreAcquire delegates through the supplied pre-acquirer", async () => {
    const preAcquireLocationModels = mock(async () => {});
    const locations = [{ uri: { toString: () => "file:///repo/target.ts" }, range: {} }];
    const sourceUri = "file:///repo/source.ts";
    const deps = { sentinel: true };
    const installation = installLocationModelPreAcquire({} as typeof Monaco, {
      preAcquireLocationModels: preAcquireLocationModels as any,
    });

    await installation.preAcquireLocationModels(locations as any, sourceUri, deps as any);

    expect(preAcquireLocationModels).toHaveBeenCalledTimes(1);
    expect(preAcquireLocationModels.mock.calls[0]).toEqual([locations, sourceUri, deps]);
  });
});
