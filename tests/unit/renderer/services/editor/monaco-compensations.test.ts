import { describe, expect, test } from "bun:test";
import type * as Monaco from "monaco-editor";
import {
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
});
