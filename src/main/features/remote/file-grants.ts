import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  FILE_GRANT_IDLE_MS,
  FILE_GRANT_MAX_MS,
  type FileAccessErrorData,
  type FileLinkSource,
  RpcErrorCode,
} from "../../../../packages/remote-protocol/src";
import { RpcFailure } from "./room";

export const MAX_FILE_GRANTS_PER_DEVICE = 64;
export const FILE_GRANT_ISSUE_WINDOW_MS = 10_000;
export const MAX_FILE_GRANT_ISSUES_PER_WINDOW = 20;
const MAX_DROPPED_TOKENS = 1024;

export interface FileGrantPlace {
  readonly workspaceId: string;
  readonly rootPath: string;
  readonly location: unknown;
}

export interface FileGrantRead extends FileGrantPlace {
  readonly device: string;
  readonly epoch: string;
  readonly path: string;
}

export interface FileGrantWant extends FileGrantRead {
  readonly tabId: string;
  readonly realPath: string | null;
  readonly source: FileLinkSource;
  readonly parent?: string;
}

export interface FileGrant extends FileGrantWant {
  readonly token: string;
  readonly issuedAt: number;
  usedAt: number;
}

export interface FileGrantIssued {
  readonly grant: string;
  readonly expiresInMs: number;
  readonly idleMs: number;
}

export interface FileGrantsOptions {
  readonly now?: () => number;
  readonly newToken?: () => string;
}

type Dropped = "expired" | "invalid";

export function grantInvalid(message: string): RpcFailure {
  return new RpcFailure(RpcErrorCode.Forbidden, message, {
    grant: "invalid",
  } satisfies FileAccessErrorData);
}

export function grantRequired(message: string): RpcFailure {
  return new RpcFailure(RpcErrorCode.Forbidden, message, {
    grant: "required",
  } satisfies FileAccessErrorData);
}

export function grantExpired(): RpcFailure {
  return new RpcFailure(RpcErrorCode.GrantExpired, "that file grant has expired: ask again");
}

export class FileGrants {
  private readonly grants = new Map<string, FileGrant>();
  private readonly dropped = new Map<string, Dropped>();
  private readonly issues = new Map<string, number[]>();
  private readonly now: () => number;
  private readonly newToken: () => string;

  constructor({
    now = Date.now,
    newToken = () => randomBytes(32).toString("base64url"),
  }: FileGrantsOptions = {}) {
    this.now = now;
    this.newToken = newToken;
  }

  issue(want: FileGrantWant): FileGrantIssued {
    const now = this.now();
    this.prune(now);
    const held = this.reusable(want);
    if (held) {
      this.touch(held.token);
      return this.issued(held, now);
    }
    const recent = (this.issues.get(want.device) ?? []).filter(
      (at) => now - at < FILE_GRANT_ISSUE_WINDOW_MS,
    );
    if (recent.length >= MAX_FILE_GRANT_ISSUES_PER_WINDOW) {
      this.issues.set(want.device, recent);
      throw new RpcFailure(
        RpcErrorCode.Unavailable,
        "that device asked for too many file grants just now: ask again shortly",
      );
    }
    this.issues.set(want.device, [...recent, now]);
    const mine = [...this.grants.values()].filter((g) => g.device === want.device);
    if (mine.length >= MAX_FILE_GRANTS_PER_DEVICE) {
      const oldest = mine.reduce((a, b) => (b.usedAt < a.usedAt ? b : a));
      this.drop([oldest.token], "expired");
    }
    const grant: FileGrant = { ...want, token: this.newToken(), issuedAt: now, usedAt: now };
    this.grants.set(grant.token, grant);
    if (want.parent !== undefined) this.touch(want.parent);
    return this.issued(grant, now);
  }

  check(token: string, read: FileGrantRead): FileGrant {
    const now = this.now();
    this.prune(now);
    const grant = this.grants.get(token);
    if (!grant) {
      if (this.dropped.get(token) === "invalid") {
        throw grantInvalid("that file grant was withdrawn");
      }
      throw grantExpired();
    }
    if (
      grant.device !== read.device ||
      grant.epoch !== read.epoch ||
      grant.workspaceId !== read.workspaceId ||
      grant.rootPath !== read.rootPath ||
      !isDeepStrictEqual(grant.location, read.location) ||
      grant.path !== read.path
    ) {
      throw grantInvalid("that file grant is for another file, workspace or device");
    }
    return grant;
  }

  touch(token: string): void {
    const now = this.now();
    const seen = new Set<string>();
    let grant = this.grants.get(token);
    while (grant && !seen.has(grant.token) && this.live(grant, now)) {
      seen.add(grant.token);
      grant.usedAt = now;
      grant = grant.parent === undefined ? undefined : this.grants.get(grant.parent);
    }
  }

  sourcesOf(workspaceId: string, tabId: string): FileGrant[] {
    this.prune(this.now());
    return [...this.grants.values()].filter(
      (g) => g.workspaceId === workspaceId && g.tabId === tabId,
    );
  }

  withdraw(tokens: readonly string[]): void {
    this.drop(tokens, "invalid");
  }

  dropTab(workspaceId: string, tabId: string): void {
    this.withdraw(this.sourcesOf(workspaceId, tabId).map((g) => g.token));
  }

  dropDevice(device?: string): void {
    this.drop(
      [...this.grants.values()]
        .filter((g) => device === undefined || g.device === device)
        .map((g) => g.token),
      "expired",
    );
    if (device === undefined) this.issues.clear();
    else this.issues.delete(device);
  }

  get size(): number {
    return this.grants.size;
  }

  private reusable(want: FileGrantWant): FileGrant | undefined {
    const key = want.realPath ?? want.path;
    for (const g of this.grants.values()) {
      if (
        g.device === want.device &&
        g.epoch === want.epoch &&
        g.tabId === want.tabId &&
        g.workspaceId === want.workspaceId &&
        g.rootPath === want.rootPath &&
        g.path === want.path &&
        (g.realPath ?? g.path) === key &&
        isDeepStrictEqual(g.location, want.location)
      ) {
        return g;
      }
    }
    return undefined;
  }

  private issued(grant: FileGrant, now: number): FileGrantIssued {
    return {
      grant: grant.token,
      expiresInMs: Math.max(1, grant.issuedAt + FILE_GRANT_MAX_MS - now),
      idleMs: FILE_GRANT_IDLE_MS,
    };
  }

  private live(grant: FileGrant, now: number): boolean {
    return now - grant.usedAt < FILE_GRANT_IDLE_MS && now - grant.issuedAt < FILE_GRANT_MAX_MS;
  }

  private prune(now: number): void {
    const stale = [...this.grants.values()].filter((g) => !this.live(g, now)).map((g) => g.token);
    if (stale.length > 0) this.drop(stale, "expired");
  }

  private drop(tokens: readonly string[], why: Dropped): void {
    const pending = [...tokens];
    while (pending.length > 0) {
      const token = pending.pop() as string;
      if (!this.grants.delete(token)) continue;
      this.remember(token, why);
      for (const child of this.grants.values()) {
        if (child.parent === token) pending.push(child.token);
      }
    }
  }

  private remember(token: string, why: Dropped): void {
    this.dropped.delete(token);
    this.dropped.set(token, why);
    while (this.dropped.size > MAX_DROPPED_TOKENS) {
      const first = this.dropped.keys().next().value as string;
      this.dropped.delete(first);
    }
  }
}
