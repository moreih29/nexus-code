import { randomUUID } from "node:crypto";
import {
  type BugReport,
  type BugReportContext,
  BugReportCreatedSchema,
} from "../../../../packages/remote-protocol/src";
import { createLogger } from "../../../shared/log/main";
import {
  type BugReportDraft,
  type BugReportFacts,
  type BugReportLocale,
  type BugReportOutcome,
  bugReportContext,
  buildBugReport,
  cleanBugReportDescription,
} from "../../../shared/remote/bug-report";
import { ServerError, SignedOutError, UnreachableError } from "./errors";
import type { RecentErrors } from "./recent-errors";

const log = createLogger("remote-bug-report");

export interface BugReportsDeps {
  account: { sendBugReport(body: BugReport): Promise<unknown> };
  errors: Pick<RecentErrors, "list">;
  facts(): BugReportFacts;
  newId?: () => string;
}

export class BugReports {
  private pending: { key: string; id: string } | null = null;

  constructor(private readonly deps: BugReportsDeps) {}

  context(locale: BugReportLocale, includeErrors: boolean): BugReportContext {
    return bugReportContext(
      this.deps.facts(),
      locale,
      includeErrors ? this.deps.errors.list() : null,
    );
  }

  async send(draft: BugReportDraft): Promise<BugReportOutcome> {
    const key = JSON.stringify([
      cleanBugReportDescription(draft.description),
      draft.contactOk,
      draft.includeErrors,
      draft.locale,
    ]);
    if (this.pending?.key !== key) {
      this.pending = { key, id: (this.deps.newId ?? randomUUID)() };
    }
    const pending = this.pending;
    try {
      const body = buildBugReport(
        pending.id,
        draft,
        this.context(draft.locale, draft.includeErrors),
      );
      const created = BugReportCreatedSchema.parse(await this.deps.account.sendBugReport(body));
      if (this.pending === pending) this.pending = null;
      return { status: "sent", id: created.id };
    } catch (error) {
      const outcome = failureOf(error);
      log.warn(`Bug report not sent failure=${outcome.failure}`);
      return outcome;
    }
  }
}

type Failed = Extract<BugReportOutcome, { status: "failed" }>;

function failureOf(error: unknown): Failed {
  const failed = (failure: Failed["failure"]): Failed => ({ status: "failed", failure });
  if (error instanceof SignedOutError) {
    return failed(error.status === 403 ? "not-allowed" : "signed-out");
  }
  if (error instanceof UnreachableError) return failed("offline");
  if (error instanceof ServerError) {
    if (error.status === 429) {
      return error.retryAfter !== undefined
        ? { status: "failed", failure: "rate-limited", retryAfter: error.retryAfter }
        : failed("rate-limited");
    }
    if (error.status === 401) return failed("signed-out");
    if (error.status === 403) return failed("not-allowed");
    if (error.status === 413) return failed("too-big");
    if (error.status === 404 || error.code === "unsupported_version") return failed("unsupported");
  }
  return failed("failed");
}
