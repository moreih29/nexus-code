import i18next, { type TFunction } from "i18next";
import { ChevronDown, Shield } from "lucide-react";
import {
  createContext,
  type MouseEvent,
  type ReactElement,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  ConsentAnswer,
  RemoteConsent,
  RemoteSession,
} from "../../../../packages/remote-protocol/src/rpc";
import { consentDetailsOf } from "../../../shared/cli/consent-copy";
import type { CliChangeKind } from "../../../shared/cli/ui";
import type { IpcResult } from "../../../shared/ipc/result";
import { createListenerBus } from "../../../shared/util/listener-bus";
import { shortId } from "../../../shared/util/short-id";
import { ipcCallResult } from "../../ipc/client";
import { refreshPeerSessions } from "../../services/remote/room";
import { cn } from "../../utils/cn";
import { DeviceTag } from "../agent-list/session-row";
import { PERMISSION_CARD_CLASS, RequestPager } from "../chat/permission-card";
import {
  CONSENT_CONFIRM_BUTTON_CLASS,
  CONSENT_DESCRIPTION_CLASS,
  consentNamesTarget,
  consentTitleOf,
  describeConsent,
} from "../cli/consent-dialog";
import { Button } from "../ui/button";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

const GONE_SHOWN_MS = 1500;

const consentChanges = createListenerBus();
let settledConsents: ReadonlySet<string> = new Set();
const settledSnapshot = () => settledConsents;
const consentKey = (deviceId: string, id: string) => JSON.stringify([deviceId, id]);

export function usePeerConsents(
  deviceId: string,
  consents: readonly RemoteConsent[] | undefined,
): RemoteConsent[] {
  const pending = useConsentIsPending();
  return (consents ?? []).filter((consent) => pending(deviceId, consent.id));
}

export function useConsentIsPending() {
  const settled = useSyncExternalStore(consentChanges.subscribe, settledSnapshot, settledSnapshot);
  return (deviceId: string, id: string) => !settled.has(consentKey(deviceId, id));
}

export function consentFromChat(
  { from }: RemoteConsent,
  { workspaceId, tabId }: { workspaceId: string; tabId: string },
): boolean {
  return !from.device && !from.manager && from.workspaceId === workspaceId && from.tabId === tabId;
}

export function PeerConsentCard({
  consent,
  deviceId,
  device,
  workspaceName,
  sessions,
}: {
  consent: RemoteConsent;
  deviceId: string;
  device: string;
  workspaceName: string;
  sessions: readonly RemoteSession[] | undefined;
}) {
  return (
    <RemoteConsentCard
      consent={consent}
      device={device}
      workspaceName={workspaceName}
      sessions={sessions}
      onAnswer={(answer) =>
        ipcCallResult("remote", "peerConsentAnswer", { deviceId, id: consent.id, answer })
      }
      onSettled={() => {
        const key = consentKey(deviceId, consent.id);
        if (settledConsents.has(key)) return;
        settledConsents = new Set(settledConsents).add(key);
        consentChanges.notify();
        refreshPeerSessions(deviceId);
      }}
    />
  );
}

export function consentActionOf(t: TFunction<"settings">, change: RemoteConsent["change"]): string {
  const key = `agentCli.consent.action.${change.kind}`;
  return i18next.exists(key, { ns: "settings" })
    ? t(key as `agentCli.consent.action.${CliChangeKind}`, {
        detail: consentDetailsOf(t, change).detail,
      })
    : t("agentCli.consent.action_unknown", { kind: change.kind });
}

export function consentHeadlineOf(
  t: TFunction<"settings">,
  change: RemoteConsent["change"],
  title: string,
): string {
  const key = `agentCli.consent.headline.${change.kind}`;
  return i18next.exists(key, { ns: "settings" })
    ? t(key as `agentCli.consent.headline.${CliChangeKind}`, {
        detail: consentDetailsOf(t, change).detail,
      })
    : title;
}

export const CONSENT_SWAP_HOLD_MS = 500;

interface ConsentPage {
  held: () => boolean;
  answering: () => void;
}

const ConsentPageContext = createContext<ConsentPage>({
  held: () => false,
  answering: () => {},
});

const leftUnanswered = new Map<string, number>();

export function ConsentPages({
  place,
  children,
}: {
  place: string;
  children: readonly ReactElement[];
}) {
  const keys = children.map((child) => String(child.key));
  const view = useRef<{ key?: string; index: number }>({ index: 0 });
  const answered = useRef<string | undefined>(undefined);
  const hold = useRef<{ key: string; until: number } | null>(null);
  const [, repaint] = useState(0);
  const before = view.current;
  const found = before.key === undefined ? -1 : keys.indexOf(before.key);
  const shown = found >= 0 ? found : Math.min(before.index, Math.max(0, keys.length - 1));
  const shownKey = keys[shown];
  useLayoutEffect(() => {
    const previous = view.current;
    if (
      previous.key !== undefined &&
      shownKey !== undefined &&
      previous.key !== shownKey &&
      !keys.includes(previous.key) &&
      answered.current !== previous.key
    )
      hold.current = { key: shownKey, until: performance.now() + CONSENT_SWAP_HOLD_MS };
    view.current = { key: shownKey, index: shown };
  });
  useLayoutEffect(() => {
    const left = leftUnanswered.get(place);
    leftUnanswered.delete(place);
    const first = view.current.key;
    if (first !== undefined && left !== undefined) {
      const until = left + CONSENT_SWAP_HOLD_MS;
      if (performance.now() < until) hold.current = { key: first, until };
    }
    return () => {
      const last = view.current.key;
      if (last !== undefined && answered.current !== last)
        leftUnanswered.set(place, performance.now());
    };
  }, [place]);
  const page: ConsentPage = {
    held: () =>
      hold.current !== null &&
      hold.current.key === shownKey &&
      performance.now() < hold.current.until,
    answering: () => {
      answered.current = shownKey;
    },
  };
  const paged = children.length > 1;
  return (
    <ConsentPageContext.Provider value={page}>
      <div className="flex flex-col gap-1" data-testid={paged ? "remote-consent-pages" : undefined}>
        {paged && (
          <RequestPager
            shown={shown}
            total={children.length}
            onShow={(index) => {
              view.current = { key: keys[index], index };
              repaint((n) => n + 1);
            }}
          />
        )}
        {children[shown] ?? null}
      </div>
    </ConsentPageContext.Provider>
  );
}

export function consentSentenceOf(
  t: TFunction<"settings">,
  consent: RemoteConsent,
  to: string,
  sessions?: readonly RemoteSession[],
): string {
  const { from } = consent;
  const action = consentActionOf(t, consent.change);
  const namesTarget = consentNamesTarget(consent.change.kind);
  if (from.manager && !from.device) {
    const destination = namesTarget ? "" : t("agentCli.consent.destination", { to });
    return t("agentCli.consent.manager_description", { destination, action });
  }
  const kind = sessions?.find((session) => consentFromChat(consent, session))?.kind;
  return describeConsent(
    t,
    {
      fromWorkspace: from.workspaceName ?? shortId(from.workspaceId),
      fromTab: from.name ?? shortId(from.tabId),
      ...(kind === "claude" || kind === "codex" ? { fromAgent: kind } : {}),
      ...(from.device ? { fromDevice: from.device.name } : {}),
      toWorkspace: to,
      sameWorkspace: !from.device && from.workspaceId === consent.workspaceId,
    },
    action,
    namesTarget,
    consent.change.kind === "sandboxExecution",
  );
}

export function RemoteConsentCard({
  consent,
  device,
  workspaceName,
  sessions,
  onAnswer,
  onSettled,
}: {
  consent: RemoteConsent;
  device: string;
  workspaceName: string;
  sessions?: readonly RemoteSession[] | undefined;
  onAnswer: (answer: ConsentAnswer) => Promise<IpcResult<unknown>>;
  onSettled: () => void;
}) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation();
  const [busy, setBusy] = useState<ConsentAnswer | null>(null);
  const [gone, setGone] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { body } = consentDetailsOf(t, consent.change);
  const [open, setOpen] = useState(() => body?.includes("\n") === true);
  const toggled = useRef(false);
  const bodyBox = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const box = bodyBox.current;
    if (!box || !body || open || toggled.current) return;
    if (box.scrollWidth > box.clientWidth) setOpen(true);
  }, [body, open]);

  const page = useContext(ConsentPageContext);
  const answer = async (choice: ConsentAnswer) => {
    if (busy !== null || gone || page.held()) return;
    page.answering();
    setBusy(choice);
    setFailure(null);
    const result = await onAnswer(choice);
    if (result.ok) {
      onSettled();
      return;
    }
    setBusy(null);
    if (result.kind === "not-found") {
      setGone(true);
      setFailure(tc("agentView.remote.consentGone"));
      setTimeout(onSettled, GONE_SHOWN_MS);
      return;
    }
    setFailure(tc("agentView.remote.failed", { message: result.message }));
  };
  const answerOnce = (event: MouseEvent, choice: ConsentAnswer) => {
    if (event.detail > 1) return;
    void answer(choice);
  };
  const idle = busy === null && !gone;

  const title = t(consentTitleOf(consent.change.kind, Boolean(consent.from.device)));
  const headline = consentHeadlineOf(t, consent.change, title);
  const sentence = consentSentenceOf(t, consent, workspaceName, sessions);
  const { from } = consent;
  const asker = from.manager && !from.device ? undefined : (from.name ?? shortId(from.tabId));
  return (
    <section aria-label={title} className={PERMISSION_CARD_CLASS} data-testid="remote-consent">
      <div className="flex flex-col gap-2">
        <div className="flex items-start gap-2">
          <Shield aria-hidden className="mt-0.5 size-4 shrink-0 text-[var(--state-warning-fg)]" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className={cn("font-semibold text-foreground", CONSENT_DESCRIPTION_CLASS)}>
              {headline}
            </span>
            <span
              aria-hidden
              className="flex min-w-0 items-center gap-1.5 text-app-micro text-muted-foreground"
              title={sentence}
            >
              {from.device && <DeviceTag name={from.device.name} />}
              <span className="min-w-0 truncate">
                {asker ? `${asker} → ${workspaceName}` : workspaceName}
              </span>
            </span>
            <p className="sr-only">{sentence}</p>
          </div>
        </div>
        {body && (
          <button
            ref={bodyBox}
            type="button"
            aria-expanded={open}
            title={open ? undefined : body}
            onClick={() => {
              toggled.current = true;
              setOpen(!open);
            }}
            className={cn(
              "block w-full min-w-0 rounded-(--radius-control) bg-background px-2 py-1 text-left font-mono text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring",
              open
                ? "app-scrollbar max-h-40 overflow-auto whitespace-pre-wrap break-all"
                : "overflow-hidden text-ellipsis whitespace-nowrap",
            )}
          >
            {body}
          </button>
        )}
        {consent.answerable ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              loading={busy === "deny"}
              disabled={!idle}
              onClick={(event) => answerOnce(event, "deny")}
            >
              {tc("chat.permission.deny_send")}
            </Button>
            <span className="inline-flex">
              <Button
                size="sm"
                className={cn(CONSENT_CONFIRM_BUTTON_CLASS, !consent.eachTime && "rounded-r-none")}
                loading={busy === "once"}
                disabled={!idle}
                onClick={(event) => answerOnce(event, "once")}
              >
                {t("agentCli.consent.allow")}
              </Button>
              {!consent.eachTime && (
                <DropdownMenuRoot>
                  <DropdownMenuTrigger>
                    <Button
                      size="sm"
                      className={cn(
                        CONSENT_CONFIRM_BUTTON_CLASS,
                        "rounded-l-none border-l border-l-primary-foreground/25 px-1.5",
                      )}
                      loading={busy === "session"}
                      disabled={!idle}
                      tooltip={t("agentCli.consent.allow_choices")}
                    >
                      <ChevronDown aria-hidden className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem disabled={!idle} onSelect={() => void answer("session")}>
                      {t("agentCli.consent.session")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenuRoot>
              )}
            </span>
          </div>
        ) : (
          <p className="text-app-micro text-muted-foreground" data-testid="remote-consent-there">
            {tc("agentView.remote.consentThere", { device })}
          </p>
        )}
        {failure && (
          <p role="alert" className="text-app-micro text-(--state-error-fg)">
            {failure}
          </p>
        )}
      </div>
    </section>
  );
}
