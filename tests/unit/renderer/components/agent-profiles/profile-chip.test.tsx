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

function chip(
  profileId: string,
  onContinue: (id: string) => Promise<boolean>,
  onSwitch: (id: string) => void = () => {},
) {
  return (
    <ProfileUsageChip
      agent="claude"
      workspaceId="ws-1"
      profileId={profileId}
      use="conversation"
      onSwitch={onSwitch}
      onContinue={onContinue}
    />
  );
}

async function withWorkProfile(run: (notify: ReturnType<typeof spyOn>) => Promise<void>) {
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
    await run(notify);
  } finally {
    notify.mockRestore();
    popover.mockRestore();
  }
}

async function pickWork(testId: "chat-profile-pick" | "chat-profile-new") {
  const button = document.querySelector<HTMLButtonElement>('[data-testid="chat-profile-chip"]');
  await act(async () => button?.click());
  const pick = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  expect(pick).not.toBeNull();
  await act(async () => pick?.click());
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
          return Promise.resolve(true);
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

test("a move that failed tells nothing when the profile changes later another way", async () => {
  await withWorkProfile(async (notify) => {
    await withTestDom(async (_host, root) => {
      const view = (profileId: string) => chip(profileId, () => Promise.resolve(false));
      await act(async () => root.render(view("claude-default")));
      await pickWork("chat-profile-pick");
      await act(async () => root.render(view("work")));
      expect(notify).not.toHaveBeenCalled();
    });
  });
});

test("starting a new conversation in a profile after a move tells nothing about a move", async () => {
  await withWorkProfile(async (notify) => {
    await withTestDom(async (_host, root) => {
      const switched: string[] = [];
      const view = (profileId: string) =>
        chip(
          profileId,
          () => new Promise<boolean>(() => {}),
          (id) => switched.push(id),
        );
      await act(async () => root.render(view("claude-default")));
      await pickWork("chat-profile-pick");
      await pickWork("chat-profile-new");
      expect(switched).toEqual(["work"]);
      await act(async () => root.render(view("work")));
      expect(notify).not.toHaveBeenCalled();
    });
  });
});
