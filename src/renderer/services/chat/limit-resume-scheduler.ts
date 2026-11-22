/**
 * Runs limit-resume: keeps in each Claude and Codex tab when to go on after
 * the plan's usage limit stopped it, and at that time sends the agent the
 * message to go on.
 *
 * - A tab's conversation is looked at as it changes (a turn ends, one
 *   starts), and every 30 seconds, as the window is shown again, and as the
 *   computer wakes or its screen is unlocked (system.woke): times are
 *   compared with the clock, so one that passed in sleep or while the app
 *   was closed comes due at once (the record is kept in the tab's layout).
 * - A stop with no reset told asks the plan's usage once (through a tab of
 *   the profile, or a program started to ask); with none there either, the
 *   tab only says so.
 * - At the time, the plan's usage is asked again: a limit that still holds
 *   puts it off to the reset it tells now, up to the configured attempt limit.
 * - Tabs of one profile go STAGGER_MS apart.
 * - A window that sends claims the message in localStorage, so another
 *   window with the same tab does not send it too.
 */

import i18next from "i18next";
import { type AgentProfile, profileOf } from "../../../shared/agent-profiles/profiles";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import type { LimitResume } from "../../../shared/types/layout";
import { ipcListen } from "../../ipc/client";
import { useAgentProfilesStore } from "../../state/stores/agent-profiles";
import { useNotificationsStore } from "../../state/stores/notifications";
import { useTabsStore } from "../../state/stores/tabs";
import { agentTabController } from "./agent-tab";
import { ChatController } from "./claude/controller";
import { CodexController } from "./codex/controller";
import {
  afterRecheck,
  FRESH_PLAN_MS,
  failedResume,
  planBlockedUntil,
  reconcileResume,
  resumeDue,
  STAGGER_MS,
  sentResume,
  withResetTime,
} from "./limit-resume";
import { planUsageKeyFor, usePlanUsageStore, wantPlanUsage } from "./plan-usage";
import { chatKey, useChatStore } from "./store";
import { sendToAgentTab } from "./transport/submission";

const TICK_MS = 30_000;
/** A claim older than this is another window's that is gone. */
const CLAIM_MS = 2 * 60_000;
const CLAIM_PREFIX = "nexus.limitResume:";
const WINDOW_ID = crypto.randomUUID();

/** Tabs whose message is on its way. */
const firing = new Set<string>();
/** The latest stop each tab had a record for, or let go, by chat key. */
const handled = new Map<string, number>();
/** Stops whose reset was asked of the plan's usage, by chat key and stop. */
const asked = new Set<string>();
/** When the next message of each profile may go, by plan usage key. */
const nextSlot = new Map<string, number>();

interface ChatTabRef {
  workspaceId: string;
  tabId: string;
  agent: ChatAgent;
  cwd: string;
  profileId?: string;
  session?: string;
  record?: LimitResume;
}

function tabRef(workspaceId: string, tabId: string): ChatTabRef | null {
  const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
  if (tab?.type === "claude") {
    const { cwd, profileId, sessionId, limitResume } = tab.props;
    return {
      workspaceId,
      tabId,
      agent: "claude",
      cwd,
      ...(profileId ? { profileId } : {}),
      ...(sessionId ? { session: sessionId } : {}),
      ...(limitResume ? { record: limitResume } : {}),
    };
  }
  if (tab?.type === "codex") {
    const { cwd, profileId, threadId, limitResume } = tab.props;
    return {
      workspaceId,
      tabId,
      agent: "codex",
      cwd,
      ...(profileId ? { profileId } : {}),
      ...(threadId ? { session: threadId } : {}),
      ...(limitResume ? { record: limitResume } : {}),
    };
  }
  return null;
}

function chatTabs(): ChatTabRef[] {
  const refs: ChatTabRef[] = [];
  for (const [workspaceId, tabs] of Object.entries(useTabsStore.getState().byWorkspace)) {
    for (const tabId of Object.keys(tabs ?? {})) {
      const ref = tabRef(workspaceId, tabId);
      if (ref) refs.push(ref);
    }
  }
  return refs;
}

/** A plan's limits: a Claude account, or Codex signed in with ChatGPT rather than a key. */
function isSubscription(profile: AgentProfile): boolean {
  return !profile.connection || profile.connection.method === "account";
}

function enabled(): boolean {
  return useNotificationsStore.getState().limitResume;
}

function options() {
  return useNotificationsStore.getState().limitResumeOptions;
}

function setRecord(ref: ChatTabRef, record: LimitResume | undefined): void {
  useTabsStore.getState().setLimitResume(ref.workspaceId, ref.tabId, record);
  if (record) ref.record = record;
  else delete ref.record;
}

function planKeyOf(ref: ChatTabRef): string {
  return planUsageKeyFor(ref.agent, ref.workspaceId, ref.profileId);
}

/** Asks the plan's usage now, through a tab of the profile, or a program started to ask. */
function askPlanUsage(ref: ChatTabRef): Promise<void> {
  const probe =
    ref.agent === "claude" ? ChatController.probePlanUsage : CodexController.probePlanUsage;
  return wantPlanUsage(planKeyOf(ref), {
    force: true,
    probe: {
      agent: ref.agent,
      fetchUsage: () =>
        probe({
          workspaceId: ref.workspaceId,
          cwd: ref.cwd,
          ...(ref.profileId ? { profileId: ref.profileId } : {}),
        }),
    },
  });
}

/** Sends a tab the app's message, starting its program if it is not running. */
async function sendAppMessage(workspaceId: string, tabId: string, text: string): Promise<void> {
  const target = agentTabController(workspaceId, tabId);
  if (!target) throw new Error("the tab is gone");
  await sendToAgentTab(workspaceId, tabId, target, text, { kind: "app" });
}

/** What the scheduler does past the stores; tests put in their own. */
export const limitResumeIo = {
  askPlan: askPlanUsage,
  send: sendAppMessage,
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

/** When the plan's used-up limit resets, from usage heard since `since`. */
function planResetSince(ref: ChatTabRef, since: number): number | undefined {
  const plan = usePlanUsageStore.getState().byKey[planKeyOf(ref)];
  if (plan?.fetchedAt === undefined || plan.fetchedAt < since) return undefined;
  return planBlockedUntil(plan, ref.agent);
}

/** Brings a tab's record up to its conversation; returns it as kept. */
function reconcile(ref: ChatTabRef, now: number): LimitResume | undefined {
  const key = chatKey(ref.workspaceId, ref.tabId);
  const chat = useChatStore.getState().tabs[key];
  const profile = profileOf(useAgentProfilesStore.getState().config, ref.agent, ref.profileId);
  const was = ref.record;
  const handledAt = handled.get(key);
  const next = reconcileResume(
    was,
    {
      agent: ref.agent,
      ...(chat ? { model: chat.model } : {}),
      ...(ref.session ? { session: ref.session } : {}),
      subscription: isSubscription(profile),
      enabled: enabled(),
      now,
      ...(handledAt !== undefined ? { handledAt } : {}),
    },
    options(),
  );
  for (const record of [was, next]) {
    if (record) handled.set(key, Math.max(handled.get(key) ?? 0, record.stopAt));
  }
  if (next !== was) setRecord(ref, next);
  if (next?.state === "unknown") findReset(ref, next, now);
  return ref.record;
}

/**
 * A stop with no reset told: the plan's usage, if it tells one, at once;
 * else asked once, for this stop.
 */
function findReset(ref: ChatTabRef, record: LimitResume, now: number): void {
  const known = withResetTime(record, planResetSince(ref, record.stopAt), now, options());
  if (known !== record) {
    setRecord(ref, known);
    return;
  }
  const key = `${chatKey(ref.workspaceId, ref.tabId)}@${record.stopAt}`;
  if (asked.has(key)) return;
  asked.add(key);
  void limitResumeIo
    .askPlan(ref)
    .catch(() => undefined)
    .then(() => {
      const current = tabRef(ref.workspaceId, ref.tabId);
      if (!current?.record || current.record.stopAt !== record.stopAt) return;
      const told = withResetTime(
        current.record,
        planResetSince(current, record.stopAt),
        Date.now(),
        options(),
      );
      if (told !== current.record) setRecord(current, told);
    });
}

/** Whether this window sends the message: none other claimed it. */
function claim(ref: ChatTabRef, record: LimitResume): boolean {
  const id = `${CLAIM_PREFIX}${ref.workspaceId}:${ref.tabId}:${record.stopAt}:${record.tries}`;
  try {
    const [owner, at] = (localStorage.getItem(id) ?? "").split("|");
    if (owner && owner !== WINDOW_ID && Date.now() - Number(at) < CLAIM_MS) return false;
    localStorage.setItem(id, `${WINDOW_ID}|${Date.now()}`);
  } catch {
    // No storage: this window is the only one that can tell.
  }
  return true;
}

/** Forgets claims of a day ago and more. */
function sweepClaims(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const id = localStorage.key(i);
      if (!id?.startsWith(CLAIM_PREFIX)) continue;
      const at = Number((localStorage.getItem(id) ?? "").split("|")[1]);
      if (!(Date.now() - at < 24 * 60 * 60_000)) localStorage.removeItem(id);
    }
  } catch {
    // Nothing kept to forget.
  }
}

/**
 * Sends the tab the message to go on: at its time, once the plan's usage
 * says the limit no longer holds; or now, as the user asked (`now`).
 */
async function fire(ref: ChatTabRef, now: boolean): Promise<void> {
  const key = chatKey(ref.workspaceId, ref.tabId);
  if (firing.has(key) || !ref.record) return;
  const stopAt = ref.record.stopAt;
  firing.add(key);
  try {
    const planKey = planKeyOf(ref);
    if (!now) {
      const asking = Date.now();
      await limitResumeIo.askPlan(ref).catch(() => undefined);
      const current = tabRef(ref.workspaceId, ref.tabId);
      if (current?.record?.stopAt !== stopAt) return;
      const checkedAt = Date.now();
      const record = reconcile(current, checkedAt);
      if (!record || record.stopAt !== stopAt || !resumeDue(record, checkedAt)) return;
      const plan = usePlanUsageStore.getState().byKey[planKey];
      const fresh = plan?.fetchedAt !== undefined && plan.fetchedAt >= asking - FRESH_PLAN_MS;
      const step = afterRecheck(
        record,
        planBlockedUntil(plan, current.agent),
        fresh,
        checkedAt,
        options(),
      );
      if (step !== "send") {
        setRecord(current, step);
        return;
      }
    }
    // One profile's tabs a few seconds apart.
    const slot = Math.max(Date.now(), nextSlot.get(planKey) ?? 0);
    nextSlot.set(planKey, slot + STAGGER_MS);
    if (slot > Date.now()) await limitResumeIo.sleep(slot - Date.now());
    const current = tabRef(ref.workspaceId, ref.tabId);
    if (current?.record?.stopAt !== stopAt) return;
    const sendingAt = Date.now();
    const record = now ? current.record : reconcile(current, sendingAt);
    if (!record || record.stopAt !== stopAt || record.state === "sent") return;
    if (!now && !resumeDue(record, sendingAt)) return;
    if (!claim(current, record)) return;
    setRecord(current, sentResume(record, sendingAt));
    try {
      await limitResumeIo.send(
        current.workspaceId,
        current.tabId,
        options().chatLimitResumeMessage.trim() || i18next.t("common:chat.limit_resume.prompt"),
      );
    } catch {
      const after = tabRef(current.workspaceId, current.tabId);
      if (after?.record?.state === "sent" && after.record.stopAt === stopAt) {
        setRecord(after, failedResume(record, Date.now(), options()));
      }
    }
  } finally {
    firing.delete(key);
  }
}

/** Looks at every chat tab: brings its record up, and sends where the time came. */
export function tickLimitResume(now = Date.now()): void {
  for (const ref of chatTabs()) {
    const record = reconcile(ref, now);
    if (enabled() && resumeDue(record, now)) void fire(ref, false);
  }
}

/** Goes on in the tab now, as the user asked: the message is sent without waiting. */
export function resumeLimitNow(workspaceId: string, tabId: string): Promise<void> {
  const ref = tabRef(workspaceId, tabId);
  return ref ? fire(ref, true) : Promise.resolve();
}

/** Calls off going on in the tab: it stays stopped, and says when the limit resets. */
export function cancelLimitResume(workspaceId: string, tabId: string): void {
  const ref = tabRef(workspaceId, tabId);
  if (!ref?.record || ref.record.state === "sent") return;
  const { at: _was, ...rest } = ref.record;
  setRecord(ref, { ...rest, state: "cancelled" });
}

let stop: (() => void) | null = null;

/** Starts looking at the tabs; the function it gives back stops. */
export function startLimitResume(): () => void {
  stop?.();
  sweepClaims();
  const unsubscribeChats = useChatStore.subscribe((state, prev) => {
    if (state.tabs === prev.tabs) return;
    const now = Date.now();
    for (const [key, chat] of Object.entries(state.tabs)) {
      const was = prev.tabs[key]?.model;
      const model = chat?.model;
      if (!model || model === was) continue;
      if (
        model.lastResult === was?.lastResult &&
        model.running === was?.running &&
        model.turn?.startedAt === was?.turn?.startedAt
      ) {
        continue;
      }
      const at = key.lastIndexOf(":");
      const ref = at > 0 ? tabRef(key.slice(0, at), key.slice(at + 1)) : null;
      if (ref) reconcile(ref, now);
    }
  });
  const timer = setInterval(() => tickLimitResume(), TICK_MS);
  const onVisible = () => {
    if (document.visibilityState === "visible") tickLimitResume();
  };
  document.addEventListener("visibilitychange", onVisible);
  const unlistenWoke = ipcListen("system", "woke", () => tickLimitResume());
  tickLimitResume();
  stop = () => {
    unsubscribeChats();
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
    unlistenWoke();
    stop = null;
  };
  return stop;
}

/** For tests: forgets what was handled, asked and claimed in this window. */
export function resetLimitResume(): void {
  stop?.();
  firing.clear();
  handled.clear();
  asked.clear();
  nextSlot.clear();
}
