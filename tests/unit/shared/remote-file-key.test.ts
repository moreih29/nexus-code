import { expect, test } from "bun:test";
import { parseRemoteFileKey, remoteFileKey } from "../../../src/shared/fs/remote-file-key";

const peer = { deviceId: "dev", workspaceId: "ws" };

test("a drive letter of either case gives one remote file key", () => {
  const upper = remoteFileKey({ ...peer, path: "C:/w/docs/plan.md" });
  expect(remoteFileKey({ ...peer, path: "c:/w/docs/plan.md" })).toBe(upper);
  expect(remoteFileKey({ ...peer, path: "c:/w/Docs/plan.md" })).not.toBe(upper);
});

test("a POSIX path keeps its case in the key", () => {
  expect(remoteFileKey({ ...peer, path: "/c:/a" })).not.toBe(
    remoteFileKey({ ...peer, path: "/C:/a" }),
  );
});

test("a key with a lower-case drive is not a valid key", () => {
  const key = remoteFileKey({ ...peer, path: "c:/w/a.md" });
  expect(parseRemoteFileKey(key)?.path).toBe("C:/w/a.md");
  expect(parseRemoteFileKey(key.replace("C%3A", "c%3A"))).toBeNull();
});
