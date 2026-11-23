import { afterEach, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  NotesPanelView,
  noteChips,
} from "../../../../../src/renderer/components/notes/notes-panel";
import { PeerReadOnlyBadge } from "../../../../../src/renderer/components/peer-workspace/labels";
import {
  PeerNoteMarkdown,
  withoutHeading,
} from "../../../../../src/renderer/components/peer-workspace/note-tab";
import {
  listPeerNotes,
  readPeerNote,
} from "../../../../../src/renderer/components/peer-workspace/notes-model";
import { PeerNotesPanel } from "../../../../../src/renderer/components/peer-workspace/notes-panel";
import * as ipc from "../../../../../src/renderer/ipc/client";
import {
  peerTabId,
  peerTargetId,
  usePeerWorkspaceStore,
} from "../../../../../src/renderer/state/stores/peer-workspace";
import { ipcOk } from "../../../../../src/shared/ipc/result";

const peer = { deviceId: "desk", workspaceId: "project" };
const rows = [
  { id: "n1", title: "Fake plan", updatedAt: Date.UTC(2026, 2, 1, 15) },
  { id: "n2", title: "", updatedAt: Date.UTC(2026, 2, 1, 14) },
];
const target = {
  ...peer,
  accountKey: "a",
  deviceName: "Desk",
  workspace: { id: "project", name: "project", path: "/p" },
};
const initial = usePeerWorkspaceStore.getState();
afterEach(() => usePeerWorkspaceStore.setState(initial, true));

test("the list and a note are asked through the peer read calls, without an agent sender", async () => {
  const note = {
    id: "n1",
    title: "Fake plan",
    updatedAt: 1,
    markdown: "# Fake plan\n",
    transcript: "",
  };
  const call = spyOn(ipc, "ipcCallResult");
  call.mockResolvedValueOnce(ipcOk({ notes: rows })).mockResolvedValueOnce(ipcOk(note));
  const { signal } = new AbortController();
  try {
    expect(await listPeerNotes(peer, signal)).toEqual(ipcOk({ notes: rows }));
    expect(call).toHaveBeenLastCalledWith("remote", "peerNotesList", peer, { signal });
    expect(await readPeerNote(peer, "n1", signal)).toEqual(ipcOk(note));
    expect(call).toHaveBeenLastCalledWith(
      "remote",
      "peerNotesRead",
      { ...peer, note: "n1" },
      { signal },
    );
  } finally {
    call.mockRestore();
  }
});

test("the shared notes view reads only without a create action: no New note button, no chips", () => {
  const remote = renderToStaticMarkup(
    <NotesPanelView
      notes={rows}
      error={false}
      activeNoteId="n1"
      onOpen={() => {}}
      badge={<PeerReadOnlyBadge compact />}
    />,
  );
  expect(remote).toContain("Fake plan");
  expect(remote).toContain("Untitled");
  expect(remote).toContain("Read-only");
  expect(remote).not.toContain("New note");
  expect(remote).not.toContain("rounded-(--radius-pill)");
  expect(noteChips({})).toEqual([]);

  const local = renderToStaticMarkup(
    <NotesPanelView
      notes={[
        {
          ...rows[0],
          excerpt: "",
          counts: { sketches: 0, files: 0, images: 0, todos: 2, todosDone: 1 },
        },
      ]}
      error={false}
      activeNoteId={null}
      workspaceId="w1"
      onOpen={() => {}}
      onCreate={() => {}}
    />,
  );
  expect(local).toContain("New note");
  expect(local).toContain("rounded-(--radius-pill)");
});

test("the notes view says so when nothing was read and that computer is out of reach", () => {
  const markup = renderToStaticMarkup(
    <PeerNotesPanel target={target} canRead={false} rejoin={0} />,
  );
  expect(markup).not.toContain("New note");
  expect(markup).not.toContain('data-testid="notes-panel"');
});

test("a note's Markdown follows web links only and loads nothing from this computer", () => {
  const markup = renderToStaticMarkup(
    <PeerNoteMarkdown
      source={[
        "[site](https://example.com) [file](../secret.txt) [app](nexus://x)",
        "",
        "![sketch](attachments/s.png)",
        "",
        "<img src=x onerror=alert(1)>",
        "",
        "- [x] done",
      ].join("\n")}
    />,
  );
  expect(markup).toContain('href="https://example.com"');
  expect(markup).not.toContain('href="../secret.txt"');
  expect(markup).not.toContain('href="nexus://x"');
  expect(markup).toContain("[sketch]");
  expect(markup).not.toContain("<img");
  expect(markup).toMatch(/<input[^>]*disabled/);
});

test("the heading notes.read puts first is dropped: the tab's title row says it", () => {
  expect(withoutHeading("# Fake plan\n\nBody\n# Later")).toBe("Body\n# Later");
  expect(withoutHeading("Body only")).toBe("Body only");
});

test("a note opens in one tab however often it is picked", () => {
  const id = peerTargetId(target);
  usePeerWorkspaceStore.getState().select(target, null);
  const { openNote } = usePeerWorkspaceStore.getState();
  openNote(id, { noteId: "n1", title: "Fake plan" });
  openNote(id, { noteId: "n2", title: "" });
  openNote(id, { noteId: "n1", title: "Fake plan" });
  const view = usePeerWorkspaceStore.getState().views[id];
  expect(view?.tabs.map((tab) => tab.type)).toEqual(["peer.note", "peer.note"]);
  expect(view?.activePath).toBe(peerTabId({ type: "peer.note", noteId: "n1", title: "" }));
});
