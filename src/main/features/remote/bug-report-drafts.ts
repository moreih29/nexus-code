import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type BugReportFields,
  BugReportFieldsSchema,
  EMPTY_BUG_REPORT_FIELDS,
} from "../../../shared/remote/bug-report";
import type { Kept } from "./sealed-file";

export const BUG_REPORT_DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const StoredBugReportDraftSchema = z.object({
  owner: z.string(),
  id: z.uuid(),
  updatedAt: z.number().int().nonnegative(),
  fields: BugReportFieldsSchema,
});
type StoredBugReportDraft = z.infer<typeof StoredBugReportDraftSchema>;

function sameFields(left: BugReportFields, right: BugReportFields): boolean {
  return (
    left.description === right.description &&
    left.contactOk === right.contactOk &&
    left.includeErrors === right.includeErrors
  );
}

export class BugReportDrafts {
  private queued: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: Kept<StoredBugReportDraft>,
    private readonly owner: () => string | null,
    private readonly now = Date.now,
  ) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queued.then(operation, operation);
    this.queued = result;
    return result;
  }

  private async current(): Promise<StoredBugReportDraft | null> {
    if (this.owner() === null) {
      this.store.clear();
      return null;
    }
    const draft = await this.store.load();
    if (!draft) return null;
    const age = this.now() - draft.updatedAt;
    if (draft.owner === this.owner() && age >= 0 && age < BUG_REPORT_DRAFT_TTL_MS) return draft;
    this.store.clear();
    return null;
  }

  prune(): Promise<void> {
    return this.enqueue(async () => {
      await this.current();
    });
  }

  drop(): Promise<void> {
    return this.enqueue(async () => this.store.clear());
  }

  read(owner: string): Promise<BugReportFields | null> {
    return this.enqueue(async () => {
      const draft = await this.current();
      return draft?.owner === owner ? draft.fields : null;
    });
  }

  write(owner: string, fields: BugReportFields): Promise<void> {
    return this.enqueue(async () => {
      if (owner !== this.owner()) return;
      const previous = await this.current();
      if (owner !== this.owner()) return;
      if (sameFields(fields, EMPTY_BUG_REPORT_FIELDS)) {
        this.store.clear();
      } else if (!previous || !sameFields(fields, previous.fields)) {
        await this.store.save({ owner, fields, id: randomUUID(), updatedAt: this.now() });
      }
    });
  }

  idFor(owner: string, fields: BugReportFields): Promise<string | undefined> {
    return this.enqueue(async () => {
      const draft = await this.current();
      return draft?.owner === owner && sameFields(fields, draft.fields) ? draft.id : undefined;
    });
  }

  sent(owner: string, id: string): Promise<void> {
    return this.enqueue(async () => {
      const draft = await this.current();
      if (draft?.owner === owner && draft.id === id) this.store.clear();
    });
  }
}
