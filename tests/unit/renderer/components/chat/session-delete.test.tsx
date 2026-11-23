import { expect, test } from "bun:test";
import i18next from "i18next";
import { act } from "react";
import { SessionPicker } from "../../../../../src/renderer/components/chat/session-list";
import { CodexForkedHistoryError } from "../../../../../src/renderer/services/chat/codex/controller";
import type { ListedSession } from "../../../../../src/renderer/services/chat/sessions";
import { withTestDom } from "../../../../helpers/test-dom";

const PARENT: ListedSession = {
  sessionId: "parent",
  title: "Parent conversation",
  lastModified: 1_763_000_000_000,
  profileId: "codex-default",
};

async function refuse(error: Error): Promise<{ rows: string[]; said: string; asked: number }> {
  let asked = 0;
  let result = { rows: [] as string[], said: "", asked: 0 };
  await withTestDom(async (host, root) => {
    await act(async () =>
      root.render(
        <SessionPicker
          agent="codex"
          listed={[PARENT]}
          openIn={new Map()}
          workspaceId="ws"
          tabId="tab"
          profileId="codex-default"
          profiles={[]}
          onResume={() => {}}
          onClose={() => {}}
          onDelete={() => {
            asked += 1;
            return Promise.reject(error);
          }}
        />,
      ),
    );
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="chat-session-delete"]')?.click(),
    );
    const confirm = host.querySelector('[data-testid="chat-session-delete-confirm"]');
    const buttons = Array.from(confirm?.querySelectorAll("button") ?? []);
    await act(async () => buttons.at(-1)?.click());
    result = {
      rows: Array.from(host.querySelectorAll("li")).map((row) => row.textContent ?? ""),
      said: confirm?.textContent ?? "",
      asked,
    };
  });
  return result;
}

test("a refused delete of a parent a fork still uses says so and keeps the row", async () => {
  const { rows, said, asked } = await refuse(
    new CodexForkedHistoryError("cannot delete thread parent: forked history still references it"),
  );
  expect(asked).toBe(1);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toContain("Parent conversation");
  expect(said).toContain(i18next.t("chat.sessions.delete_forked"));
  expect(said).not.toContain("forked history still references it");
});

test("another refused delete shows what went wrong and keeps the row", async () => {
  const { rows, said } = await refuse(new Error("disk full"));
  expect(rows).toHaveLength(1);
  expect(said).toContain(i18next.t("chat.sessions.delete_failed", { message: "disk full" }));
});
