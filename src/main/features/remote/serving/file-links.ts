import { stat } from "node:fs/promises";
import path from "node:path";
import {
  type FileLinkSource,
  MAX_FILE_SOURCE_PARENT_BYTES,
  RpcErrorCode,
  type RpcParams,
  type RpcResult,
} from "../../../../../packages/remote-protocol/src";
import { cleanLinkHref, isHtmlFile, textLinksTo } from "../../../../shared/chat/link-text";
import { isAutoMountPath, isDevicePath } from "../../../../shared/fs/outside-url";
import { createLogger } from "../../../../shared/log/main";
import { shortId } from "../../../../shared/util/short-id";
import type { CliServices } from "../../cli/context";
import type { FsProvider } from "../../fs/bridge/provider";
import type { FileGrant, FileGrants } from "../file-grants";
import {
  absoluteFilePath,
  hostFilePath,
  isAbsoluteFor,
  looksBinary,
  namesNetworkPath,
  networkLinkRefusal,
  networkRootOf,
  outsideRealPath,
  placeOrRealRoot,
  type RemoteFiles,
  realWithin,
  sameHostPath,
  styleOf,
  textOf,
  throughNoLink,
} from "../files";
import { RpcFailure } from "../room";
import { unavailable, workspaceOf } from "./common";
import type { RemoteServeRequest } from "./types";

const log = createLogger("remote-serving");

const CANDIDATE_CHECKS_AT_ONCE = 8;

export interface OutsideSets {
  files: readonly string[];
  standing: readonly string[];
  agent: readonly string[];
}

export function outsideSetsOf(s: CliServices, workspaceId: string): Promise<OutsideSets> {
  return s.ui("chat.outsideFiles", { workspaceId }).then(
    (r) => ({ files: r.files ?? [], standing: r.standing ?? [], agent: r.agent ?? [] }),
    () => ({ files: [], standing: [], agent: [] }),
  );
}

export interface LinkContext {
  readonly s: CliServices;
  readonly from: string;
  readonly epoch: string;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly rootPath: string;
  readonly location: unknown;
  readonly fs: FsProvider;
  readonly folders: readonly string[];
  readonly sets: OutsideSets;
  readonly grants: FileGrants;
  readonly files: Omit<RemoteFiles, "folders">;
}

type Look =
  | { kind: "inside"; path: string; rel: string }
  | { kind: "folder"; path: string }
  | { kind: "outside"; path: string }
  | { kind: "blocked" }
  | { kind: "skip" };

type Mode = "auto" | "click";

function inStanding(ctx: LinkContext, p: string): boolean {
  return ctx.sets.standing.some((known) => sameHostPath(ctx.rootPath, known, p));
}

async function lookAt(ctx: LinkContext, candidate: string, mode: Mode): Promise<Look> {
  if (candidate.includes("\0")) return { kind: "skip" };
  const p = hostFilePath(ctx.rootPath, candidate);
  if (!isAbsoluteFor(ctx.rootPath, p)) return { kind: "skip" };
  try {
    const place = await placeOrRealRoot(ctx.files, ctx.workspaceId, ctx.rootPath, ctx.folders, p);
    if (place.kind === "workspace") return { kind: "inside", path: p, rel: place.rel };
    return { kind: "folder", path: p };
  } catch (error) {
    if (!(error instanceof RpcFailure) || error.code !== RpcErrorCode.Forbidden) throw error;
  }
  if ([p, path.posix.normalize(p.replace(/\\/g, "/"))].some(isDevicePath)) {
    return { kind: "blocked" };
  }
  if (ctx.fs.kind === "local") {
    try {
      absoluteFilePath(p);
    } catch {
      return { kind: "blocked" };
    }
  }
  if (namesNetworkPath(candidate) && !namesNetworkPath(p)) return { kind: "blocked" };
  if (namesNetworkPath(p)) {
    const onRootShare =
      !isAutoMountPath(p) &&
      networkRootOf(p) !== null &&
      networkRootOf(p) === networkRootOf(ctx.rootPath);
    const allowed = mode === "click" ? isAutoMountPath(p) || onRootShare : onRootShare;
    if (!allowed || (mode === "auto" && !inStanding(ctx, p))) return { kind: "blocked" };
  }
  if (ctx.fs.kind === "local" && (await networkLinkRefusal(p, p, mode))) {
    return { kind: "blocked" };
  }
  return { kind: "outside", path: p };
}

type Found = { kind: "file" } | { kind: "dir" } | { kind: "refused"; error: RpcFailure } | null;

async function found(ctx: LinkContext, look: Look): Promise<Found> {
  const kindOf = (s: { isFile(): boolean; isDirectory(): boolean }): Found =>
    s.isFile() ? { kind: "file" } : s.isDirectory() ? { kind: "dir" } : null;
  try {
    if (look.kind === "inside") {
      if (!look.rel) return { kind: "dir" };
      const s = await throughNoLink(ctx.fs, look.rel, look.path);
      return s.type === "file" ? { kind: "file" } : s.type === "dir" ? { kind: "dir" } : null;
    }
    if (look.kind === "folder") {
      const real = await realWithin(ctx.fs, styleOf(ctx.rootPath), ctx.folders, look.path);
      return kindOf(await stat(real));
    }
    if (look.kind === "outside") {
      if (ctx.fs.kind === "local") return kindOf(await stat(look.path));
      const read = await ctx.fs.readAbsoluteRange(look.path, 0, 0);
      return read.kind === "missing" ? null : { kind: "file" };
    }
  } catch (error) {
    if (
      look.kind === "inside" &&
      ctx.fs.kind === "local" &&
      error instanceof RpcFailure &&
      error.code === RpcErrorCode.Forbidden
    ) {
      return { kind: "refused", error };
    }
    return null;
  }
  return null;
}

function linkPathFrom(root: string, parent: string, href: string): string | null {
  let cleaned = cleanLinkHref(href);
  if (cleaned.startsWith("file://")) {
    try {
      cleaned = decodeURIComponent(new URL(cleaned).pathname);
    } catch {
      return null;
    }
    if (/^\/[A-Za-z]:\//.test(cleaned)) cleaned = cleaned.slice(1);
  } else {
    if (/^[a-z][a-z0-9+.-]*:/i.test(cleaned) && !/^[A-Za-z]:\//.test(cleaned)) return null;
    cleaned = cleaned.replace(/[?#].*$/, "");
  }
  if (!cleaned) return null;
  const style = styleOf(root);
  if (isAbsoluteFor(root, hostFilePath(root, cleaned)) || cleaned.startsWith("/")) {
    return hostFilePath(root, cleaned);
  }
  return hostFilePath(root, style.path.join(style.path.dirname(parent), cleaned));
}

type ParentLinks = { candidates: string[] } | { beyond: true } | null;

async function parentLinks(
  ctx: LinkContext,
  source: Extract<FileLinkSource, { kind: "file" }>,
  href: string,
): Promise<{ links: ParentLinks; parentGrant?: FileGrant }> {
  const parent = hostFilePath(ctx.rootPath, source.parent);
  let parentGrant: FileGrant | undefined;
  let read: { base64: string; sizeBytes: number } | null = null;
  if (source.grant !== undefined) {
    try {
      parentGrant = ctx.grants.check(source.grant, {
        device: ctx.from,
        epoch: ctx.epoch,
        workspaceId: ctx.workspaceId,
        rootPath: ctx.rootPath,
        location: ctx.location,
        path: parent,
      });
    } catch (error) {
      if (error instanceof RpcFailure && error.code === RpcErrorCode.GrantExpired) throw error;
      return { links: null };
    }
    if (ctx.fs.kind === "local" && parentGrant.realPath !== null) {
      const real = await outsideRealPath(parent, parent, "click").catch(() => null);
      if (real !== parentGrant.realPath) return { links: null };
    }
    read = await ranged(ctx.fs.readAbsoluteRange(parent, 0, MAX_FILE_SOURCE_PARENT_BYTES));
  } else {
    const look = await lookAt(ctx, parent, "auto");
    if (look.kind === "inside") {
      if ((await found(ctx, look))?.kind !== "file") return { links: null };
      read = await ranged(ctx.fs.readRange(look.rel, 0, MAX_FILE_SOURCE_PARENT_BYTES));
    } else if (look.kind === "folder" || (look.kind === "outside" && inStanding(ctx, parent))) {
      if ((await found(ctx, look))?.kind !== "file") return { links: null };
      read = await ranged(ctx.fs.readAbsoluteRange(parent, 0, MAX_FILE_SOURCE_PARENT_BYTES));
    } else return { links: null };
  }
  if (!read) return { links: null };
  const bytes = Buffer.from(read.base64, "base64").subarray(0, MAX_FILE_SOURCE_PARENT_BYTES);
  if (looksBinary(bytes)) return { links: null };
  if (!textLinksTo(textOf(bytes), href, { html: isHtmlFile(parent) })) {
    return { links: read.sizeBytes > MAX_FILE_SOURCE_PARENT_BYTES ? { beyond: true } : null };
  }
  const candidate = linkPathFrom(ctx.rootPath, parent, href);
  return {
    links: candidate === null ? null : { candidates: [candidate] },
    ...(parentGrant ? { parentGrant } : {}),
  };
}

async function ranged(
  reading: Promise<{ kind: string; base64?: string; sizeBytes?: number }>,
): Promise<{ base64: string; sizeBytes: number } | null> {
  const read = await reading.catch(() => null);
  if (!read || read.kind === "missing" || read.base64 === undefined) return null;
  return { base64: read.base64, sizeBytes: read.sizeBytes ?? 0 };
}

async function candidatesOf(
  ctx: LinkContext,
  links: readonly { href: string; source: FileLinkSource }[],
): Promise<{ links: ParentLinks; parentGrant?: FileGrant }[]> {
  const asked = links.flatMap((link, i) =>
    link.source.kind === "file"
      ? []
      : [
          {
            i,
            link: {
              href: link.href,
              source: link.source as Exclude<FileLinkSource, { kind: "file" }>,
            },
          },
        ],
  );
  const fromChat = asked.length
    ? await ctx.s
        .ui("chat.fileLinks", {
          workspaceId: ctx.workspaceId,
          tabId: ctx.tabId,
          links: asked.map(({ link }) => link),
        })
        .catch(() => {
          throw new RpcFailure(RpcErrorCode.NotFound, "no such chat tab");
        })
    : { candidates: [] };
  const byIndex = new Map(asked.map(({ i }, at) => [i, fromChat.candidates[at] ?? null]));
  const out: { links: ParentLinks; parentGrant?: FileGrant }[] = [];
  for (const [i, link] of links.entries()) {
    if (link.source.kind === "file") out.push(await parentLinks(ctx, link.source, link.href));
    else {
      const places = byIndex.get(i) ?? null;
      out.push({ links: places && places.length > 0 ? { candidates: places } : null });
    }
  }
  return out;
}

async function contextOf(
  s: CliServices,
  request: RemoteServeRequest,
  files: Omit<RemoteFiles, "folders"> | undefined,
  grants: FileGrants | undefined,
  workspaceId: string,
  tabId: string,
): Promise<LinkContext> {
  if (!files || !grants) {
    throw new RpcFailure(RpcErrorCode.MethodNotFound, `${request.method} is not served here`);
  }
  const workspace = workspaceOf(s, workspaceId);
  if (!workspace) throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
  const fs = await files.fs(workspaceId).catch(unavailable);
  const [folders, sets] = await Promise.all([
    s
      .ui("workspace.folders", { workspaceId })
      .then((r) => r.folders)
      .catch(() => []),
    outsideSetsOf(s, workspaceId),
  ]);
  return {
    s,
    from: request.from,
    epoch: request.epoch ?? "",
    workspaceId,
    tabId,
    rootPath: workspace.rootPath,
    location: structuredClone(workspace.location),
    fs,
    folders,
    sets,
    grants,
    files,
  };
}

export async function serveFileResolve(
  s: CliServices,
  request: RemoteServeRequest,
  files: Omit<RemoteFiles, "folders"> | undefined,
  grants: FileGrants | undefined,
): Promise<RpcResult<"files.resolve">> {
  const { workspaceId, tabId, links } = request.params as RpcParams<"files.resolve">;
  const ctx = await contextOf(s, request, files, grants, workspaceId, tabId);
  const asked = await candidatesOf(ctx, links);
  const resolved: RpcResult<"files.resolve">["found"] = new Array(links.length).fill(null);
  const one = async (i: number) => {
    const places = asked[i]?.links;
    if (!places || !("candidates" in places)) return;
    for (const candidate of places.candidates) {
      const look = await lookAt(ctx, candidate, "auto");
      if (look.kind === "skip") continue;
      if (look.kind === "blocked") {
        resolved[i] = { blocked: true };
        return;
      }
      const kind = await found(ctx, look);
      if (kind?.kind === "refused") {
        resolved[i] = { path: look.path, readable: false };
        return;
      }
      if (kind?.kind !== "file") continue;
      resolved[i] = {
        path: look.path,
        readable: look.kind !== "outside" || inStanding(ctx, look.path),
      };
      return;
    }
  };
  for (let at = 0; at < links.length; at += CANDIDATE_CHECKS_AT_ONCE) {
    const batch = links.slice(at, at + CANDIDATE_CHECKS_AT_ONCE).map((_, k) => one(at + k));
    await Promise.all(batch);
  }
  return { found: resolved };
}

export async function serveFileGrant(
  s: CliServices,
  request: RemoteServeRequest,
  files: Omit<RemoteFiles, "folders"> | undefined,
  grants: FileGrants | undefined,
): Promise<RpcResult<"files.grant">> {
  const { workspaceId, tabId, href, source, purpose } = request.params as RpcParams<"files.grant">;
  const ctx = await contextOf(s, request, files, grants, workspaceId, tabId);
  const [asked] = await candidatesOf(ctx, [{ href, source }]);
  const places = asked?.links ?? null;
  if (places === null) {
    throw new RpcFailure(RpcErrorCode.NotFound, "that link is not in that part of the chat");
  }
  if ("beyond" in places) {
    throw new RpcFailure(
      RpcErrorCode.NotFound,
      "that link is not in the first part of the file read for links",
      { reason: "beyond" },
    );
  }
  let blocked = false;
  for (const candidate of places.candidates) {
    const look = await lookAt(ctx, candidate, "click");
    if (look.kind === "skip") continue;
    if (look.kind === "blocked") {
      blocked = true;
      break;
    }
    const kind = await found(ctx, look);
    if (kind === null) continue;
    if (kind.kind === "refused") throw kind.error;
    if (kind.kind === "dir") {
      throw new RpcFailure(RpcErrorCode.InvalidParams, `${look.path} is a folder, not a file`);
    }
    if (look.kind !== "outside" || inStanding(ctx, look.path)) return { path: look.path };
    const realPath =
      ctx.fs.kind === "local" ? await outsideRealPath(look.path, look.path, "click") : null;
    const issued = ctx.grants.issue({
      device: ctx.from,
      epoch: ctx.epoch,
      workspaceId,
      rootPath: ctx.rootPath,
      location: ctx.location,
      tabId,
      path: look.path,
      realPath,
      source,
      ...(asked?.parentGrant ? { parent: asked.parentGrant.token } : {}),
    });
    log.info(
      `file grant device=${shortId(ctx.from)} ws=${shortId(workspaceId)} tab=${shortId(tabId)} purpose=${purpose} source=${source.kind}${"runId" in source && source.runId ? ",run" : ""}`,
    );
    return { path: look.path, ...issued };
  }
  if (blocked) {
    throw new RpcFailure(
      RpcErrorCode.Forbidden,
      "that file is on a network or device path not opened from another device",
    );
  }
  throw new RpcFailure(RpcErrorCode.NotFound, "that file does not exist");
}

function underRoot(root: string, p: string): boolean {
  const base = hostFilePath(root, root);
  const target = hostFilePath(root, p);
  const style = styleOf(root);
  const fold = (x: string) => (style.windows ? x.toLowerCase() : x);
  const prefix = base.endsWith(style.path.sep) ? base : `${base}${style.path.sep}`;
  return fold(target) === fold(base) || fold(target).startsWith(fold(prefix));
}

export async function sourcesChanged(
  s: CliServices,
  grants: FileGrants,
  workspaceId: string,
  tabId: string,
): Promise<void> {
  const held = grants.sourcesOf(workspaceId, tabId);
  if (held.length === 0) return;
  const chat = held.filter((g) => g.source.kind !== "file");
  const present = chat.length
    ? await s
        .ui("chat.sourcesPresent", { workspaceId, tabId, sources: chat.map((g) => g.source) })
        .then((r) => r.present)
        .catch(() => null)
    : [];
  if (present === null) return;
  const gone = chat.filter((_, i) => present[i] !== true).map((g) => g.token);
  const parents = held.filter((g) => g.source.kind === "file" && g.parent === undefined);
  if (parents.length > 0) {
    const workspace = workspaceOf(s, workspaceId);
    const sets = await outsideSetsOf(s, workspaceId);
    for (const g of parents) {
      const parent = (g.source as Extract<FileLinkSource, { kind: "file" }>).parent;
      const root = workspace?.rootPath ?? g.rootPath;
      const stays =
        sets.standing.some((known) => sameHostPath(root, known, parent)) || underRoot(root, parent);
      if (!stays) gone.push(g.token);
    }
  }
  if (gone.length > 0) grants.withdraw(gone);
}
