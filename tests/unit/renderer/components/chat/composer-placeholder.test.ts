import { afterEach, describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { runningPlaceholder } from "../../../../../src/renderer/components/chat/composer";
import { setPlatformForTests } from "../../../../../src/renderer/utils/platform";

const t = ((key: string, options: { queueKey: string }) =>
  `${key} ${options.queueKey}`) as unknown as TFunction;

afterEach(() => setPlatformForTests(null));

describe("runningPlaceholder", () => {
  test("names the Mac's queue key on macOS", () => {
    setPlatformForTests("darwin");
    expect(runningPlaceholder(t)).toBe("chat.composer.placeholder_running ⌘↩");
  });

  test("names Ctrl on Linux and Windows", () => {
    for (const platform of ["linux", "win32"] as const) {
      setPlatformForTests(platform);
      expect(runningPlaceholder(t)).toBe("chat.composer.placeholder_running Ctrl+↩");
    }
  });
});
