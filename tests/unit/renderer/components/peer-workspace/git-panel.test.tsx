import { afterEach, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PeerGitPanel } from "../../../../../src/renderer/components/peer-workspace/git-panel";
import * as workspaceStore from "../../../../../src/renderer/state/stores/peer-workspace";

const { peerTargetId, usePeerWorkspaceStore } = workspaceStore;
const target: workspaceStore.PeerWorkspaceTarget = {
  accountKey: "account",
  deviceId: "peer",
  deviceName: "Desktop",
  platform: "linux",
  workspaceId: "repo",
  workspace: { id: "repo", name: "Repo", path: "/repo" },
};
const previous = usePeerWorkspaceStore.getState();

afterEach(() => usePeerWorkspaceStore.setState(previous, true));

function render(): string {
  const storeView = spyOn(workspaceStore, "usePeerWorkspaceStore");
  storeView.mockImplementation(
    Object.assign(
      <T,>(select: (state: typeof previous) => T) => select(usePeerWorkspaceStore.getState()),
      usePeerWorkspaceStore,
    ),
  );
  try {
    return renderToStaticMarkup(
      <PeerGitPanel target={target} canRead updateNeeded={false} refresh={() => {}} rejoin={0} />,
    );
  } finally {
    storeView.mockRestore();
  }
}

test("Source Control is headed by the local title row, then the changes and history toggle", () => {
  const html = render();
  expect(html).toContain("Source Control");
  // The title row first, as locally: the changes and history toggle comes after it.
  const refresh = html.indexOf('aria-label="Refresh source control"');
  expect(html.indexOf("Source Control")).toBeLessThan(refresh);
  expect(refresh).toBeLessThan(html.indexOf("History"));
  // That nothing is staged or committed is told once, by the read-only mark.
  expect(html).toContain('title="No staging or commits"');
});

test("the changes fall in the local panel's four groups, in its order", () => {
  const store = usePeerWorkspaceStore.getState();
  store.select(target, null);
  store.setGitResult(peerTargetId(target), {
    ok: true,
    value: {
      branch: "main",
      ahead: 0,
      behind: 0,
      files: [
        { path: "new.ts", unstaged: "?" },
        { path: "both.ts", staged: "M", unstaged: "M" },
        { path: "conflict.ts", staged: "U", unstaged: "U" },
      ],
    },
  });
  const html = render();
  const order = ["Merge Changes", "Staged Changes", "Changes", "Untracked"].map((label) =>
    html.indexOf(`<section aria-label="${label}"`),
  );
  expect(order.every((at) => at >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  // Read-only groups only fold: no group actions.
  expect(html).not.toContain("Stage All");
  expect(html).not.toContain("lucide-ellipsis");
});

test("a group of changes folds by a heading that leads with its chevron, no platform triangle", () => {
  const store = usePeerWorkspaceStore.getState();
  store.select(target, null);
  store.setGitResult(peerTargetId(target), {
    ok: true,
    value: { branch: "main", ahead: 0, behind: 0, files: [{ path: "a.txt", staged: "M" }] },
  });
  const html = render();
  expect(html).not.toContain("<summary");
  const heading = html.match(
    /<section aria-label="Staged Changes">.*?aria-expanded="true">(.*?)<\/button>/,
  );
  expect(heading?.[1]).toMatch(/^<svg[^>]*lucide-chevron-right/);
});
