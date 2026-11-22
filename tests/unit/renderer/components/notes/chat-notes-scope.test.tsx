import { expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SaveAnswerMenu } from "../../../../../src/renderer/components/notes/save-answer-menu";
import {
  ChatNotesProvider,
  useChatNotes,
} from "../../../../../src/renderer/services/notes/chat-notes";
import * as workspaceStore from "../../../../../src/renderer/state/stores/workspaces";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";

function ChatControls() {
  const scope = useChatNotes();
  return (
    <>
      {scope && <span data-testid="notes-in-composer" />}
      <SaveAnswerMenu claudeUuid="reply-uuid" messageId="turn-id" markdown="Answer" />
    </>
  );
}

test("peer chat has neither the composer's note scope nor the answer save action", () => {
  const peer = renderToStaticMarkup(<ChatControls />);
  expect(peer).toBe("");
  const workspace = {
    id: "workspace",
    location: { kind: "ssh", host: "ssh", remotePath: "/repo" },
  } as WorkspaceMeta;
  const state = { ...workspaceStore.useWorkspacesStore.getState(), workspaces: [workspace] };
  const useWorkspaces = spyOn(workspaceStore, "useWorkspacesStore").mockImplementation(((
    selector: (value: typeof state) => unknown,
  ) => selector(state)) as typeof workspaceStore.useWorkspacesStore);
  try {
    for (const agent of ["claude", "codex"] as const) {
      const rendered = renderToStaticMarkup(
        <ChatNotesProvider workspaceId="workspace" tabId="tab" agent={agent} visible>
          <ChatControls />
        </ChatNotesProvider>,
      );
      expect(rendered).toContain('data-testid="notes-in-composer"');
      expect(rendered).toContain('data-testid="chat-save-answer"');
    }
  } finally {
    useWorkspaces.mockRestore();
  }
});
