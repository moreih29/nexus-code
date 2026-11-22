import { expect, mock, spyOn, test } from "bun:test";
import type { MouseEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SendToAgent } from "../../../../../src/renderer/components/notes/send-to-agent";
import * as buttons from "../../../../../src/renderer/components/ui/button";
import * as popovers from "../../../../../src/renderer/components/ui/popover";
import * as agentTab from "../../../../../src/renderer/services/chat/agent-tab";
import * as placement from "../../../../../src/renderer/services/cli/placement";
import { notesApi } from "../../../../../src/renderer/services/notes/api";

test("the note's Send button saves the note, opens the chat and records its tab", async () => {
  const saved = Promise.withResolvers<boolean>();
  const recorded = Promise.withResolvers<void>();
  const writeFinished = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const beforeSend = mock(() => saved.promise);
  const onOpenChange = mock();
  const openChat = spyOn(placement, "openTab").mockReturnValue("new-tab");
  const startChat = spyOn(agentTab, "startAgentTab").mockImplementation(() => started.resolve());
  const writeLink = spyOn(notesApi, "addLink").mockImplementation(async (_, __, link) => {
    recorded.resolve();
    await writeFinished.promise;
    return { id: "l1234567", link: { ...link, createdAt: 1, updatedAt: 1 } };
  });
  const showPopover = spyOn(popovers, "Popover").mockImplementation(({ children }) => (
    <>{children}</>
  ));
  const button = spyOn(buttons, "Button");
  try {
    renderToStaticMarkup(
      <SendToAgent
        open
        onOpenChange={onOpenChange}
        workspaceId="workspace"
        cwd="/repo"
        noteId="n1234567"
        title={() => "Incident review"}
        beforeSend={beforeSend}
        trigger={<button type="button">To an agent</button>}
      />,
    );
    const click = button.mock.calls[0][0].onClick;
    expect(click).toBeDefined();
    click?.({} as MouseEvent<HTMLButtonElement>);
    click?.({} as MouseEvent<HTMLButtonElement>);
    expect(beforeSend).toHaveBeenCalledTimes(1);
    expect(openChat).not.toHaveBeenCalled();
    saved.resolve(true);
    await recorded.promise;
    expect(openChat).toHaveBeenCalledWith(
      "workspace",
      { type: "claude", props: { cwd: "/repo" } },
      { background: true },
    );
    expect(writeLink).toHaveBeenCalledWith(
      "workspace",
      "n1234567",
      expect.objectContaining({
        agent: "claude",
        workspaceId: "workspace",
        tabId: "new-tab",
        cwd: "/repo",
        kind: "note",
        title: expect.any(String),
      }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(startChat).not.toHaveBeenCalled();
    writeFinished.resolve();
    await started.promise;
    expect(startChat).toHaveBeenCalledWith(
      "workspace",
      "new-tab",
      expect.stringContaining("nexus note read n1234567"),
    );
  } finally {
    writeFinished.resolve();
    button.mockRestore();
    showPopover.mockRestore();
    writeLink.mockRestore();
    startChat.mockRestore();
    openChat.mockRestore();
  }
});
