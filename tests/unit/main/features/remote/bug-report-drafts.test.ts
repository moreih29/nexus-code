import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import {
  BUG_REPORT_DRAFT_TTL_MS,
  BugReportDrafts,
  type StoredBugReportDraftSchema,
} from "../../../../../src/main/features/remote/bug-report-drafts";
import { keptInMemory } from "../../../../../src/main/features/remote/sealed-file";
import { EMPTY_BUG_REPORT_FIELDS } from "../../../../../src/shared/remote/bug-report";

const fields = {
  description: "qa-report-loses-text",
  contactOk: true,
  includeErrors: false,
};
type StoredDraft = z.infer<typeof StoredBugReportDraftSchema>;

function setup() {
  let owner: string | null = "qa-one";
  let now = 10_000;
  const store = keptInMemory<StoredDraft>();
  const open = () =>
    new BugReportDrafts(
      store,
      () => owner,
      () => now,
    );
  return {
    open,
    store,
    switchTo: (next: string | null) => {
      owner = next;
    },
    advance: (elapsed: number) => {
      now += elapsed;
    },
  };
}

describe("saved bug report drafts", () => {
  test("saves before the first send and restores only the edited fields and retry id", async () => {
    const { open, store } = setup();
    const drafts = open();
    await drafts.write("qa-one", { ...fields });
    const id = await drafts.idFor("qa-one", fields);
    expect(id).toBeString();
    const reopened = open();
    expect(await reopened.read("qa-one")).toEqual(fields);
    expect(await reopened.idFor("qa-one", fields)).toEqual(id);
    expect(store.value?.fields).toEqual(fields);
    await reopened.sent("qa-one", id!);
    expect(await open().read("qa-one")).toBeNull();
  });

  test("preserves a concurrent edit when the older draft is sent", async () => {
    const { open } = setup();
    const drafts = open();
    await drafts.write("qa-one", fields);
    const id = await drafts.idFor("qa-one", fields);
    const edited = { ...fields, includeErrors: true };
    await Promise.all([drafts.write("qa-one", edited), drafts.sent("qa-one", id!)]);
    expect(await drafts.read("qa-one")).toEqual(edited);
    expect(await drafts.idFor("qa-one", edited)).not.toEqual(id);
    await drafts.write("qa-one", EMPTY_BUG_REPORT_FIELDS);
    expect(await drafts.read("qa-one")).toBeNull();
  });

  test("rejects stale renderer writes and removes a draft from another account", async () => {
    const { open, store, switchTo } = setup();
    const drafts = open();
    const pending = drafts.write("qa-one", fields);
    switchTo("qa-two");
    await pending;
    expect(store.value).toBeNull();
    await drafts.write("qa-two", fields);
    expect(await drafts.read("qa-one")).toBeNull();
    expect(store.value?.owner).toBe("qa-two");
    switchTo("qa-three");
    await drafts.prune();
    expect(store.value).toBeNull();
  });

  test("prunes on startup after thirty days, measured from the last edit", async () => {
    const { open, store, advance } = setup();
    await open().write("qa-one", fields);
    advance(BUG_REPORT_DRAFT_TTL_MS - 1);
    expect(await open().read("qa-one")).toEqual(fields);
    await open().write("qa-one", { ...fields, contactOk: false });
    advance(BUG_REPORT_DRAFT_TTL_MS);
    await open().prune();
    expect(store.value).toBeNull();
  });

  test("removes a draft on signed-out startup without opening its encrypted contents", async () => {
    let cleared = false;
    const drafts = new BugReportDrafts(
      {
        load: async () => {
          throw new Error("keychain is locked");
        },
        save: async () => {},
        clear: () => {
          cleared = true;
        },
      },
      () => null,
    );
    await drafts.prune();
    expect(cleared).toBe(true);
  });

  test("drops queued saves on sign-out even if the same account signs in again", async () => {
    const { open, store, switchTo } = setup();
    const drafts = open();
    const pending = drafts.write("qa-one", fields);
    switchTo(null);
    const drop = drafts.drop();
    switchTo("qa-one");
    await Promise.all([pending, drop]);
    expect(store.value).toBeNull();
  });
});
