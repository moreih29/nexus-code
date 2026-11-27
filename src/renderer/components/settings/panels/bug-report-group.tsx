import { ExternalLink } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import {
  type BugReportContext,
  type BugReportRecentError,
  MAX_BUG_REPORT_DESCRIPTION,
  MIN_BUG_REPORT_DESCRIPTION,
} from "../../../../../packages/remote-protocol/src/bug-report";
import { type RemoteAccountState, remoteAccountKey } from "../../../../shared/remote/account";
import {
  bugReportFits,
  bugReportLength,
  bugReportLocale,
  type BugReportFields as DraftFields,
  EMPTY_BUG_REPORT_FIELDS,
  MAX_BUG_REPORT_DRAFT_LENGTH,
} from "../../../../shared/remote/bug-report";
import { siteUrl } from "../../../../shared/site";
import { ipcCallResult } from "../../../ipc/client";
import { useRemoteAccount } from "../../../services/remote/account";
import {
  draftAsShown,
  type ShownBugReportContext,
  sendBugReport,
} from "../../../services/remote/bug-report";
import { Button } from "../../ui/button";
import { showToast } from "../../ui/toast";
import { ToggleChevron } from "../../ui/toggle-chevron";
import { SettingsGroup, SettingsSwitch } from "../section";

export function BugReportGroup() {
  return <BugReportSection account={useRemoteAccount()} />;
}

export function BugReportSection({ account }: { account: RemoteAccountState | null }) {
  const { t } = useTranslation("settings");
  if (account === null) {
    return (
      <SettingsGroup title={t("about.bugReport.title")}>
        <div aria-busy="true" data-testid="bug-report-pending" />
      </SettingsGroup>
    );
  }
  const owner = remoteAccountKey(account);
  if (account.status !== "signed-in" || owner === null) {
    return (
      <SettingsGroup title={t("about.bugReport.title")}>
        <SupportLink />
      </SettingsGroup>
    );
  }
  return (
    <SettingsGroup title={t("about.bugReport.title")} description={t("about.bugReport.notSent")}>
      <BugReportForm key={owner} owner={owner} email={account.user.email} />
    </SettingsGroup>
  );
}

function SupportLink() {
  const { t, i18n } = useTranslation("settings");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" asChild>
        <a
          href={siteUrl("support", i18n.language)}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="bug-report-support"
        >
          <ExternalLink className="size-3.5" aria-hidden="true" />
          {t("about.bugReport.reportOnSupport")}
        </a>
      </Button>
    </div>
  );
}

function BugReportForm({ owner, email }: { owner: string; email: string }) {
  const { i18n } = useTranslation("settings");
  const locale = bugReportLocale(i18n.language);
  const [draft, setDraft] = useState<DraftFields | null>(null);
  const fields = draft ?? EMPTY_BUG_REPORT_FIELDS;
  const { description, contactOk, includeErrors } = fields;
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<ShownBugReportContext | null>(null);
  const [sending, setSending] = useState(false);
  const latest = useRef(0);

  const draftError = useCallback(
    () => showToast({ kind: "error", message: i18n.t("settings:about.bugReport.draftError") }),
    [i18n],
  );
  useEffect(() => {
    let active = true;
    void ipcCallResult("remote", "bugReportDraft", { owner })
      .catch(() => null)
      .then((result) => {
        if (!active) return;
        if (!result?.ok) draftError();
        setDraft((result?.ok ? result.value : null) ?? EMPTY_BUG_REPORT_FIELDS);
      });
    return () => {
      active = false;
    };
  }, [owner, draftError]);

  const change = (next: DraftFields) => {
    setDraft(next);
    void ipcCallResult("remote", "saveBugReportDraft", { owner, fields: next })
      .catch(() => null)
      .then((result) => {
        if (!result?.ok) draftError();
      });
  };

  const load = useCallback(() => {
    const request = ++latest.current;
    void ipcCallResult("remote", "bugReportContext", { locale, includeErrors })
      .then((result) => {
        if (request === latest.current && result.ok) {
          setShown({ context: result.value, at: Date.now() });
        }
      })
      .catch(() => {});
  }, [locale, includeErrors]);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = () => {
    if (!open) load();
    setOpen(!open);
  };

  const send = async () => {
    setSending(true);
    try {
      const sent = await sendBugReport(owner, draftAsShown({ ...fields, locale }, shown));
      if (sent) {
        setDraft(EMPTY_BUG_REPORT_FIELDS);
        setOpen(false);
        load();
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <BugReportFields
      email={email}
      description={description}
      contactOk={contactOk}
      includeErrors={includeErrors}
      open={open}
      context={shown?.context ?? null}
      sending={sending}
      draftLoading={draft === null}
      onDiscard={
        description || contactOk || !includeErrors
          ? () => {
              change(EMPTY_BUG_REPORT_FIELDS);
              setOpen(false);
            }
          : undefined
      }
      onDescription={(description) => change({ ...fields, description })}
      onContactOk={(contactOk) => change({ ...fields, contactOk })}
      onIncludeErrors={(includeErrors) => change({ ...fields, includeErrors })}
      onToggle={toggle}
      onSend={() => void send()}
    />
  );
}

export interface BugReportFieldsProps {
  email: string;
  description: string;
  contactOk: boolean;
  includeErrors: boolean;
  open: boolean;
  context: BugReportContext | null;
  sending: boolean;
  draftLoading?: boolean;
  onDiscard?: () => void;
  onDescription(text: string): void;
  onContactOk(next: boolean): void;
  onIncludeErrors(next: boolean): void;
  onToggle(): void;
  onSend(): void;
}

export function BugReportFields(props: BugReportFieldsProps) {
  const { t } = useTranslation("settings");
  const detail = useId();
  const preview = useId();
  const length = bugReportLength(props.description);
  const fits = bugReportFits(props.description);
  const tooLong = length > MAX_BUG_REPORT_DESCRIPTION;
  const locked = props.sending || props.draftLoading;
  return (
    <div className="flex flex-col gap-3.5" data-testid="bug-report-form">
      <div className="flex min-w-0 flex-col gap-1">
        <textarea
          aria-label={t("about.bugReport.description")}
          aria-describedby={detail}
          aria-invalid={tooLong || undefined}
          placeholder={t("about.bugReport.placeholder")}
          value={props.description}
          readOnly={locked}
          maxLength={MAX_BUG_REPORT_DRAFT_LENGTH}
          onChange={(event) => props.onDescription(event.currentTarget.value)}
          rows={5}
          className={cn(
            "app-scrollbar w-full resize-y rounded-(--radius-control) border border-border bg-background p-2 text-app-body text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring",
            tooLong && "border-[var(--state-error-fg)]",
          )}
          data-testid="bug-report-description"
        />
        <p
          id={detail}
          className={cn(
            "text-right text-app-ui-sm tabular-nums text-muted-foreground",
            tooLong && "text-[var(--state-error-fg)]",
          )}
        >
          {length < MIN_BUG_REPORT_DESCRIPTION
            ? t("about.bugReport.tooShort", { min: MIN_BUG_REPORT_DESCRIPTION })
            : t("about.bugReport.length", { count: length, max: MAX_BUG_REPORT_DESCRIPTION })}
        </p>
      </div>
      <SettingsSwitch
        label={t("about.bugReport.includeErrors")}
        description={t("about.bugReport.includeErrorsDescription")}
        checked={props.includeErrors}
        disabled={locked}
        onChange={props.onIncludeErrors}
      />
      <SettingsSwitch
        label={t("about.bugReport.contact")}
        description={props.email}
        checked={props.contactOk}
        disabled={locked}
        onChange={props.onContactOk}
      />
      <div className="flex min-w-0 flex-col gap-2">
        <button
          type="button"
          aria-expanded={props.open}
          aria-controls={preview}
          className="inline-flex cursor-pointer items-center gap-0.5 self-start border-0 bg-transparent p-0 text-app-ui-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={props.onToggle}
          data-testid="bug-report-preview-toggle"
        >
          {t("about.bugReport.preview")}
          <ToggleChevron open={props.open} className="size-3 text-current" />
        </button>
        {props.open && (
          <div id={preview}>
            {props.context && (
              <BugReportPreview context={props.context} includeErrors={props.includeErrors} />
            )}
          </div>
        )}
      </div>
      <div className="flex justify-end gap-2">
        {props.onDiscard && (
          <Button
            variant="outline"
            size="sm"
            disabled={locked}
            onClick={props.onDiscard}
            data-testid="bug-report-discard"
          >
            {t("about.bugReport.discardDraft")}
          </Button>
        )}
        <Button
          size="sm"
          disabled={!fits || locked}
          onClick={props.onSend}
          data-testid="bug-report-send"
        >
          {props.sending ? t("about.bugReport.sending") : t("about.bugReport.send")}
        </Button>
      </div>
    </div>
  );
}

export function BugReportPreview({
  context,
  includeErrors,
}: {
  context: BugReportContext;
  includeErrors: boolean;
}) {
  const { t } = useTranslation("settings");
  const rows: [string, ReactNode][] = [
    [t("about.bugReport.facts.app"), <Code key="app">{context.app.version}</Code>],
    [t("about.bugReport.facts.os"), <Code key="os">{context.os.version}</Code>],
    [
      t("about.bugReport.facts.device"),
      <>
        {t(`about.bugReport.deviceKind.${context.device.kind}`)}
        {context.device.arch !== undefined && (
          <>
            {" · "}
            <Code>{context.device.arch}</Code>
          </>
        )}
      </>,
    ],
    [
      t("about.bugReport.facts.protocol"),
      <>
        <Code>{String(context.protocol.version)}</Code>
        {" · "}
        <Code>{context.protocol.package}</Code>
      </>,
    ],
    [t("about.bugReport.facts.locale"), t(`about.bugReport.localeName.${context.locale}`)],
  ];
  const errors = context.errors ?? [];
  return (
    <dl
      className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-(--radius-control) border border-border bg-background p-2 text-app-ui-sm"
      data-testid="bug-report-preview"
    >
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-all">{value}</dd>
        </div>
      ))}
      <dt className="text-muted-foreground">{t("about.bugReport.facts.errors")}</dt>
      <dd className="min-w-0" data-testid="bug-report-errors">
        {!includeErrors ? (
          <span className="text-muted-foreground">{t("about.bugReport.errorsOff")}</span>
        ) : errors.length === 0 ? (
          <span className="text-muted-foreground">{t("about.bugReport.noErrors")}</span>
        ) : (
          <ul className="flex flex-col gap-1">
            {errorLines(errors).map(({ key, text, ago, count, message }) => (
              <li key={key} className="break-all">
                <Code>{text}</Code>
                {count !== undefined && <> · {t("about.bugReport.errorCount", { count })}</>} ·{" "}
                <ErrorAgo ago={ago} />
                {message !== undefined && (
                  <div className="text-muted-foreground" data-testid="bug-report-error-message">
                    <Code>{message}</Code>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </dd>
    </dl>
  );
}

function Code({ children }: { children: string }) {
  return <code className="font-mono">{children}</code>;
}

interface ErrorLine {
  key: string;
  text: string;
  ago: number;
  count?: number;
  message?: string;
}

function errorLines(errors: readonly BugReportRecentError[]): ErrorLine[] {
  const seen = new Map<string, number>();
  return errors.map(({ ago, area, code, status, message, count }) => {
    const shownStatus = status === undefined || code === `http_${status}` ? undefined : status;
    const text = [area, code, shownStatus].filter((part) => part !== undefined).join(" ");
    const base = `${ago} ${text} ${message ?? ""}`;
    const nth = (seen.get(base) ?? 0) + 1;
    seen.set(base, nth);
    return {
      key: `${base} ${nth}`,
      text,
      ago,
      ...(count !== undefined && count > 1 ? { count } : {}),
      ...(message !== undefined ? { message } : {}),
    };
  });
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;

function ErrorAgo({ ago }: { ago: number }) {
  const { t } = useTranslation("settings");
  if (ago < MINUTE) return t("about.bugReport.agoSeconds", { count: ago });
  if (ago < HOUR) return t("about.bugReport.agoMinutes", { count: Math.floor(ago / MINUTE) });
  return t("about.bugReport.agoHours", { count: Math.floor(ago / HOUR) });
}
