import {
  FileAccessErrorDataSchema,
  type FileGrantPurpose,
  type FileLinkSource,
  type FileResolved,
  MAX_FILE_RESOLVE_LINKS,
  RpcErrorCode,
  type RpcParams,
  type RpcResult,
} from "../../../../packages/remote-protocol/src";
import type { PeerWorkspace } from "../../../shared/fs/peer-url";
import type { RoomState } from "../../../shared/remote/room";
import { RpcFailure } from "./room";

type GrantParams = RpcParams<"files.grant">;
type GrantResult = RpcResult<"files.grant">;
type ResolveParams = RpcParams<"files.resolve">;
type ResolveResult = RpcResult<"files.resolve">;

export interface PeerFileGrantCalls {
  grant(deviceId: string, params: GrantParams, signal?: AbortSignal): Promise<GrantResult>;
  resolve(deviceId: string, params: ResolveParams, signal?: AbortSignal): Promise<ResolveResult>;
}

export interface PeerFileLink {
  href: string;
  source: FileLinkSource;
}

interface Held {
  tabId: string;
  href: string;
  source: FileLinkSource;
  purpose: FileGrantPurpose;
  grant?: string;
  expiresAt?: number;
}

interface DeviceScope {
  rejoins: number;
  grants: boolean;
  held: Map<string, Held>;
  renewing: Map<string, Promise<boolean>>;
}

export type GrantFailure = "expired" | "required" | "invalid";

const MAX_HELD = 256;
const MAX_CHAIN = 8;

export const FILE_GRANTS = "files.grants";

export function grantFailure(error: unknown): GrantFailure | null {
  if (!(error instanceof RpcFailure)) return null;
  if (error.code === RpcErrorCode.GrantExpired) return "expired";
  if (error.code !== RpcErrorCode.Forbidden) return null;
  const data = FileAccessErrorDataSchema.safeParse(error.data ?? {});
  return data.success ? (data.data.grant ?? null) : null;
}

function withoutToken(source: FileLinkSource): FileLinkSource {
  if (source.kind !== "file" || source.grant === undefined) return source;
  return { kind: "file", parent: source.parent };
}

export class PeerFileGrants {
  private readonly devices = new Map<string, DeviceScope>();

  constructor(
    private readonly calls: PeerFileGrantCalls,
    private readonly now: () => number = Date.now,
  ) {}

  updateRoom(state: RoomState): void {
    const online = new Map(
      state.status === "online" ? state.peers.filter((p) => p.online).map((p) => [p.id, p]) : [],
    );
    for (const [id, scope] of this.devices) {
      const peer = online.get(id);
      if (
        !peer ||
        scope.rejoins !== (peer.rejoins ?? 0) ||
        scope.grants !== (peer.serves?.includes(FILE_GRANTS) === true)
      ) {
        this.devices.delete(id);
      }
    }
    for (const [id, peer] of online) {
      if (this.devices.has(id)) continue;
      this.devices.set(id, {
        rejoins: peer.rejoins ?? 0,
        grants: peer.serves?.includes(FILE_GRANTS) === true,
        held: new Map(),
        renewing: new Map(),
      });
    }
  }

  invalidateDevice(id: string): void {
    this.devices.delete(id);
  }

  async grant(
    peer: PeerWorkspace,
    tabId: string,
    link: PeerFileLink,
    purpose: FileGrantPurpose,
    signal?: AbortSignal,
  ): Promise<{ path: string }> {
    const scope = this.scope(peer.deviceId);
    const result = await this.ask(peer, tabId, link, purpose, signal, 0);
    this.hold(scope, peer, result, { tabId, href: link.href, source: link.source, purpose });
    return { path: result.path };
  }

  async resolve(
    peer: PeerWorkspace,
    tabId: string,
    links: readonly PeerFileLink[],
    signal?: AbortSignal,
  ): Promise<FileResolved[]> {
    this.scope(peer.deviceId);
    const found: FileResolved[] = [];
    for (let at = 0; at < links.length; at += MAX_FILE_RESOLVE_LINKS) {
      const part = links.slice(at, at + MAX_FILE_RESOLVE_LINKS);
      found.push(...(await this.resolvePart(peer, tabId, part, signal)));
    }
    return found;
  }

  token(peer: PeerWorkspace, path: string): string | undefined {
    return this.devices.get(peer.deviceId)?.held.get(this.key(peer, path))?.grant;
  }

  holds(peer: PeerWorkspace, path: string): boolean {
    return this.devices.get(peer.deviceId)?.held.has(this.key(peer, path)) === true;
  }

  stale(peer: PeerWorkspace, path: string): boolean {
    const held = this.devices.get(peer.deviceId)?.held.get(this.key(peer, path));
    return held?.expiresAt !== undefined && held.expiresAt <= this.now();
  }

  forget(peer: PeerWorkspace, path: string): void {
    this.devices.get(peer.deviceId)?.held.delete(this.key(peer, path));
  }

  renew(peer: PeerWorkspace, path: string, signal?: AbortSignal, depth = 0): Promise<boolean> {
    const scope = this.devices.get(peer.deviceId);
    const key = this.key(peer, path);
    const held = scope?.held.get(key);
    if (!scope || !held || depth > MAX_CHAIN) return Promise.resolve(false);
    const pending = scope.renewing.get(key);
    if (pending) return pending;
    const renewal = this.ask(
      peer,
      held.tabId,
      { href: held.href, source: held.source },
      held.purpose,
      signal,
      depth,
    )
      .then((result) => {
        if (this.devices.get(peer.deviceId) !== scope) return false;
        if (result.path !== path) {
          scope.held.delete(key);
          return false;
        }
        this.hold(scope, peer, result, held);
        return true;
      })
      .catch((error: unknown) => {
        if (
          this.devices.get(peer.deviceId) === scope &&
          error instanceof RpcFailure &&
          (error.code === RpcErrorCode.NotFound || error.code === RpcErrorCode.Forbidden)
        ) {
          scope.held.delete(key);
        }
        throw error;
      })
      .finally(() => {
        if (scope.renewing.get(key) === renewal) scope.renewing.delete(key);
      });
    scope.renewing.set(key, renewal);
    return renewal;
  }

  private scope(deviceId: string): DeviceScope {
    const scope = this.devices.get(deviceId);
    if (!scope) throw new RpcFailure(RpcErrorCode.Unavailable, "that device is not in the room");
    if (!scope.grants) {
      throw new RpcFailure(RpcErrorCode.MethodNotFound, "that device does not serve file grants");
    }
    return scope;
  }

  private key(peer: PeerWorkspace, path: string): string {
    return JSON.stringify([peer.workspaceId, path]);
  }

  private hold(scope: DeviceScope, peer: PeerWorkspace, result: GrantResult, held: Held): void {
    const key = this.key(peer, result.path);
    scope.held.delete(key);
    scope.held.set(key, {
      tabId: held.tabId,
      href: held.href,
      source: withoutToken(held.source),
      purpose: held.purpose,
      ...(result.grant !== undefined ? { grant: result.grant } : {}),
      ...(result.expiresInMs !== undefined ? { expiresAt: this.now() + result.expiresInMs } : {}),
    });
    for (const oldest of scope.held.keys()) {
      if (scope.held.size <= MAX_HELD) break;
      scope.held.delete(oldest);
    }
  }

  private withParent(peer: PeerWorkspace, source: FileLinkSource): FileLinkSource {
    if (source.kind !== "file") return source;
    const grant = this.token(peer, source.parent);
    return grant ? { kind: "file", parent: source.parent, grant } : withoutToken(source);
  }

  private async ask(
    peer: PeerWorkspace,
    tabId: string,
    link: PeerFileLink,
    purpose: FileGrantPurpose,
    signal: AbortSignal | undefined,
    depth: number,
  ): Promise<GrantResult> {
    const send = () =>
      this.calls.grant(
        peer.deviceId,
        {
          workspaceId: peer.workspaceId,
          tabId,
          href: link.href,
          source: this.withParent(peer, link.source),
          purpose,
        },
        signal,
      );
    try {
      return await send();
    } catch (error) {
      if (!(await this.renewParent(peer, link.source, error, signal, depth))) throw error;
      return send();
    }
  }

  private async resolvePart(
    peer: PeerWorkspace,
    tabId: string,
    links: readonly PeerFileLink[],
    signal: AbortSignal | undefined,
  ): Promise<FileResolved[]> {
    const send = async () =>
      (
        await this.calls.resolve(
          peer.deviceId,
          {
            workspaceId: peer.workspaceId,
            tabId,
            links: links.map(({ href, source }) => ({
              href,
              source: this.withParent(peer, source),
            })),
          },
          signal,
        )
      ).found;
    try {
      return await send();
    } catch (error) {
      if (grantFailure(error) !== "expired") throw error;
      const parents = new Set(
        links.flatMap(({ source }) =>
          source.kind === "file" && this.token(peer, source.parent) ? [source.parent] : [],
        ),
      );
      const renewed = await Promise.all(
        [...parents].map((parent) => this.renew(peer, parent, signal, 1).catch(() => false)),
      );
      if (!renewed.some(Boolean)) throw error;
      return send();
    }
  }

  private async renewParent(
    peer: PeerWorkspace,
    source: FileLinkSource,
    error: unknown,
    signal: AbortSignal | undefined,
    depth: number,
  ): Promise<boolean> {
    if (source.kind !== "file" || grantFailure(error) !== "expired") return false;
    if (!this.token(peer, source.parent)) return false;
    return this.renew(peer, source.parent, signal, depth + 1).catch(() => false);
  }
}
