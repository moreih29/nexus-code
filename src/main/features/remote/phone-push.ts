import { randomBytes } from "node:crypto";
import {
  DeviceIdSchema,
  PUSH_TTL_SECONDS,
  PUSH_VERSION,
  PushSendResultSchema,
  PushSendSchema,
  type ServerInfo,
} from "../../../../packages/remote-protocol/src";
import { createLogger } from "../../../shared/log/main";
import type { PhonePushPolicy } from "../../../shared/types/app-state";
import type { CliServices } from "../cli/context";
import type { RemoteAccount } from "./account";
import { type ConsentControls, refusalFor } from "./consents";
import { UnreachableError } from "./errors";
import { snapshotSessions } from "./serving/sessions";

const log = createLogger("remote-push");
const RECHECK_MS = 3_000;
const DISCOVERY_MS = 60_000;
const CONSENT_GRACE_MS = 10_000;
const REQUEST_GRACE_MS = 20_000;
const REQUEST_TTL = 600;
const SEND_TIMEOUT_MS = 20_000;

type Kind = "consent" | "request";
type AccountDevice = { id: string; platform: string };

interface PushEvent {
  id: string;
  readyAt: number;
  expiresAt: number;
  attempts: number;
  done: boolean;
  sending?: AbortController;
}

function createEvent(readyAt: number, expiresAt: number): PushEvent {
  return {
    id: randomBytes(16).toString("base64url"),
    readyAt,
    expiresAt,
    attempts: 0,
    done: false,
  };
}

function cancelSend(event: PushEvent): void {
  if (event.sending) {
    event.done = true;
    event.sending.abort();
  }
}

export interface PhonePushActivity {
  away(): boolean;
  onScreenLockChanged?(listener: () => void): () => void;
}

interface PhonePushDeps {
  account: Pick<RemoteAccount, "token" | "info" | "devices" | "sendPush">;
  services: () => CliServices | null;
  controls: () => ConsentControls;
  policy: () => PhonePushPolicy;
  activity: PhonePushActivity;
  onEnabledChanged(): void;
  now?: () => number;
}

export class PhonePush {
  private readonly now: () => number;
  private readonly stopScreenLockListener: (() => void) | undefined;
  private token: string | undefined;
  private discovering: string | undefined;
  private supported = false;
  private hasPresence = false;
  private phones: string[] = [];
  private active = false;
  private disposed = false;
  private discoveryTimer: ReturnType<typeof setInterval> | undefined;
  private consentTimer: ReturnType<typeof setTimeout> | undefined;
  private requestTimer: ReturnType<typeof setTimeout> | undefined;
  private polling = false;
  private revision = 0;
  private readonly consents = new Map<string, PushEvent>();
  private readonly requests = new Map<string, PushEvent & { workspaceId: string }>();

  constructor(private readonly deps: PhonePushDeps) {
    this.now = deps.now ?? Date.now;
    this.stopScreenLockListener = deps.activity.onScreenLockChanged?.(() => {
      this.consentsChanged();
      this.scheduleRequests(0);
    });
  }

  enabled(): boolean {
    return this.active;
  }

  presence(devices: readonly AccountDevice[]): void {
    this.hasPresence = true;
    this.setDevices(devices);
  }

  presenceLost(): void {
    this.hasPresence = false;
  }

  deviceRemoved(id: string): void {
    this.phones = this.phones.filter((phone) => phone !== id);
    this.updateEnabled();
  }

  accountChanged(): void {
    const token = this.deps.account.token();
    if (token !== this.token) {
      this.token = token;
      this.supported = false;
      this.hasPresence = false;
      this.phones = [];
    }
    this.policyChanged();
  }

  serverInfo(info: ServerInfo): void {
    this.supported = info.push?.version === PUSH_VERSION;
    this.updateEnabled();
  }

  policyChanged(): void {
    this.updateEnabled();
    clearInterval(this.discoveryTimer);
    this.discoveryTimer = undefined;
    if (this.token && !this.disposed && this.deps.policy() !== "off") {
      void this.discover();
      this.discoveryTimer = setInterval(() => void this.discover(), DISCOVERY_MS);
      this.discoveryTimer.unref?.();
    }
    this.controlsChanged();
  }

  controlsChanged(): void {
    if (!this.deps.controls().chat) this.stopRequests();
    else this.scheduleRequests(0);
    this.consentsChanged();
  }

  consentsChanged(): void {
    clearTimeout(this.consentTimer);
    this.consentTimer = undefined;
    if (this.disposed) return;
    const pending = this.deps.services()?.consents.list() ?? [];
    const waiting = new Set(pending.map(({ id }) => id));
    for (const [id, event] of this.consents) {
      if (waiting.has(id)) continue;
      cancelSend(event);
      this.consents.delete(id);
    }
    if (pending.length === 0) return;

    const now = this.now();
    const away = this.deps.activity.away();
    const controls = this.deps.controls();
    let next = Infinity;
    for (const prompt of pending) {
      let event = this.consents.get(prompt.id);
      if (!event) {
        const readyAt = prompt.at + (away ? 0 : CONSENT_GRACE_MS);
        event = createEvent(
          readyAt,
          prompt.expiresAt !== undefined
            ? prompt.expiresAt - 2_000
            : readyAt + PUSH_TTL_SECONDS.consent.max * 1_000,
        );
        this.consents.set(prompt.id, event);
      }
      if (!this.active || refusalFor(prompt, controls) !== null) {
        cancelSend(event);
        continue;
      }
      const last = event.expiresAt - PUSH_TTL_SECONDS.consent.min * 1_000;
      if (event.done || event.sending || now > last) continue;
      if (now < event.readyAt && !away) next = Math.min(next, event.readyAt);
      else if (away || this.deps.policy() === "always") this.send("consent", event);
      else next = Math.min(next, now + RECHECK_MS, last + 1);
    }
    if (Number.isFinite(next)) {
      this.consentTimer = setTimeout(() => this.consentsChanged(), next - now);
      this.consentTimer.unref?.();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopScreenLockListener?.();
    for (const event of this.consents.values()) cancelSend(event);
    this.policyChanged();
  }

  private async discover(): Promise<void> {
    const token = this.token;
    if (!token || this.discovering === token) return;
    this.discovering = token;
    try {
      const info = await this.deps.account.info();
      if (this.disposed || this.token !== token) return;
      this.serverInfo(info);
      if (this.supported && !this.hasPresence && this.deps.policy() !== "off") {
        const devices = await this.deps.account.devices();
        if (!this.disposed && this.token === token && !this.hasPresence) this.setDevices(devices);
      }
    } catch {
    } finally {
      if (this.discovering === token) this.discovering = undefined;
    }
  }

  private setDevices(devices: readonly AccountDevice[]): void {
    this.phones = [
      ...new Set(
        devices
          .filter(
            (d) =>
              (d.platform === "ios" || d.platform === "android") &&
              DeviceIdSchema.safeParse(d.id).success,
          )
          .map((d) => d.id),
      ),
    ].slice(0, 20);
    this.updateEnabled();
  }

  private updateEnabled(): void {
    const active =
      !this.disposed &&
      !!this.token &&
      this.supported &&
      this.phones.length > 0 &&
      this.deps.policy() !== "off";
    if (active === this.active) return;
    this.active = active;
    if (active) this.scheduleRequests(0);
    else this.stopRequests();
    this.consentsChanged();
    this.deps.onEnabledChanged();
  }

  private stopRequests(): void {
    this.revision++;
    clearTimeout(this.requestTimer);
    this.requestTimer = undefined;
    for (const event of this.requests.values()) cancelSend(event);
  }

  private scheduleRequests(delay: number): void {
    if (!this.active || !this.deps.controls().chat || this.polling) return;
    clearTimeout(this.requestTimer);
    if (delay === 0) {
      this.requestTimer = undefined;
      void this.pollRequests();
      return;
    }
    this.requestTimer = setTimeout(() => {
      this.requestTimer = undefined;
      void this.pollRequests();
    }, delay);
    this.requestTimer.unref?.();
  }

  private async pollRequests(): Promise<void> {
    const services = this.deps.services();
    if (!services) {
      this.scheduleRequests(RECHECK_MS);
      return;
    }
    this.polling = true;
    const revision = this.revision;
    const startedAt = this.now();
    let next = RECHECK_MS;
    try {
      const { waitingRequests, incompleteWorkspaces } = await snapshotSessions(
        services,
        undefined,
        undefined,
        "sessions.watch",
        undefined,
        true,
      );
      if (revision !== this.revision) return;
      const waiting = new Set(waitingRequests.map(({ key }) => key));
      for (const [key, event] of this.requests) {
        if (waiting.has(key)) continue;
        cancelSend(event);
        if (!incompleteWorkspaces.has(event.workspaceId)) this.requests.delete(key);
      }
      const now = this.now();
      const away = this.deps.activity.away();
      const always = this.deps.policy() === "always";
      for (const { key, workspaceId } of waitingRequests) {
        let event = this.requests.get(key);
        if (!event) {
          event = {
            ...createEvent(now + REQUEST_GRACE_MS, now + REQUEST_TTL * 1_000),
            workspaceId,
          };
          this.requests.set(key, event);
        }
        if (event.done || event.sending) continue;
        if (away) this.send("request", event);
        else if (!always) continue;
        else if (startedAt < event.readyAt) next = Math.min(next, Math.max(0, event.readyAt - now));
        else this.send("request", event);
      }
    } catch {
    } finally {
      this.polling = false;
      this.scheduleRequests(revision === this.revision ? next : 0);
    }
  }

  private send(kind: Kind, event: PushEvent): void {
    const remaining = event.expiresAt - this.now();
    const ttl =
      kind === "request" && event.attempts === 0 ? REQUEST_TTL : Math.floor(remaining / 1_000);
    if (remaining < PUSH_TTL_SECONDS[kind].min * 1_000) {
      event.done = true;
      return;
    }
    const body = PushSendSchema.parse({ id: event.id, kind, ttl, to: this.phones });
    const controller = new AbortController();
    event.attempts++;
    event.sending = controller;
    void (async () => {
      try {
        const result = PushSendResultSchema.parse(
          await this.deps.account.sendPush(
            body,
            controller.signal,
            Math.min(SEND_TIMEOUT_MS, remaining),
          ),
        );
        event.done = true;
        if ("duplicate" in result) log.info(`${kind} duplicate=1`);
        else log.info(`${kind} sent=${result.sent} skipped=${result.skipped}`);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (!(error instanceof UnreachableError) || event.attempts >= 2) {
          event.done = true;
          log.warn(`${kind} failed=1`);
        }
      } finally {
        delete event.sending;
        if (!event.done) {
          if (kind === "consent") this.consentsChanged();
          else this.scheduleRequests(0);
        }
      }
    })();
  }
}
