import { afterEach, expect, spyOn, test } from "bun:test";
import i18next from "i18next";
import { act } from "react";
import { ProfileUsageChip } from "../../../../../src/renderer/components/agent-profiles/tab-profile";
import * as popovers from "../../../../../src/renderer/components/ui/popover";
import * as toast from "../../../../../src/renderer/components/ui/toast";
import { useAgentProfilesStore } from "../../../../../src/renderer/state/stores/agent-profiles";
import { withTestDom } from "../../../../helpers/test-dom";

const saved = useAgentProfilesStore.getState().config;

afterEach(() => {
  useAgentProfilesStore.getState().hydrate(saved);
});

function chip(profileId: string, onContinue: (id: string) => void) {
  return (
    <ProfileUsageChip
      agent="claude"
      workspaceId="ws-1"
      profileId={profileId}
      use="conversation"
      onSwitch={() => {}}
      onContinue={onContinue}
    />
  );
}

test("moving a local conversation to another profile tells the user once it has moved", async () => {
  const { config, hydrate } = useAgentProfilesStore.getState();
  hydrate({
    ...config,
    profiles: [
      ...config.profiles,
      { id: "work", name: "Work", dir: "/claude-work", color: "violet", agent: "claude" },
    ],
  });
  const notify = spyOn(toast, "showToast").mockReturnValue(1);
  const popover = spyOn(popovers, "Popover").mockImplementation(
    ({ open, onOpenChange, trigger, children, testId }) => (
      <>
        <span onClickCapture={() => onOpenChange(!open)}>{trigger}</span>
        {open && <div data-testid={testId}>{children}</div>}
      </>
    ),
  );
  try {
    await withTestDom(async (_host, root) => {
      let continued: string | null = null;
      const view = (profileId: string) =>
        chip(profileId, (id) => {
          continued = id;
        });
      await act(async () => root.render(view("claude-default")));
      const button = document.querySelector<HTMLButtonElement>('[data-testid="chat-profile-chip"]');
      expect(button).not.toBeNull();
      await act(async () => button?.click());
      const pick = document.querySelector<HTMLButtonElement>('[data-testid="chat-profile-pick"]');
      await act(async () => pick?.click());
      expect(continued).toBe("work");
      expect(notify).not.toHaveBeenCalled();
      await act(async () => root.render(view("work")));
      expect(notify).toHaveBeenCalledWith({
        kind: "info",
        message: i18next.t("chat.profile.moved", { name: "Work" }),
      });
    });
  } finally {
    notify.mockRestore();
    popover.mockRestore();
  }
});
