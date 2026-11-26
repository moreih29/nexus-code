import { stat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
  type AgentSender,
  RpcErrorCode,
  type RpcParams,
} from "../../../../../packages/remote-protocol/src";
import { shortId } from "../../../../shared/util/short-id";
import type { CliServices } from "../../cli/context";
import { isAgentBackedProvider } from "../../fs/bridge/provider";
import { AgentFileWrites } from "../agent-file-writes";
import { type AgentGate, lifetimeOf } from "../agent-gate";
import type { ConsentControls } from "../consents";
import { grantExpired, grantInvalid } from "../file-grants";
import { type FileWrites, fileWriteDestination, makeRemoteDirectory } from "../file-writes";
import {
  absoluteFilePath,
  absoluteReadPath,
  hostFilePath,
  isAbsoluteFor,
  listFiles,
  namesNetworkPath,
  networkRootOf,
  outsideFileSource,
  type RemoteFiles,
  readFile,
  refuseOutsideRead,
} from "../files";
import { RpcFailure } from "../room";
import { findFiles, searchFiles } from "../search";
import { unavailable, workspaceOf } from "./common";
import { outsideSetsOf } from "./file-links";
import type { RemoteServeOptions, RemoteServeRequest } from "./types";

function checkFileControl(
  anywhere: true | undefined,
  by: AgentSender | undefined,
  agents: AgentGate | undefined,
  controls: ConsentControls | undefined,
): void {
  if (!by || !agents) throw new RpcFailure(RpcErrorCode.Forbidden, "an agent sender is required");
  agents.checkRead();
  if (anywhere ? !controls?.terminal : !controls?.chat) {
    throw new RpcFailure(
      RpcErrorCode.Forbidden,
      anywhere
        ? "file access outside the workspace requires terminal control"
        : "workspace file writes require chat control",
    );
  }
}

function workspaceFolders(s: CliServices, workspaceId: string): Promise<readonly string[]> {
  return s
    .ui("workspace.folders", { workspaceId })
    .then((r) => r.folders)
    .catch(() => []);
}

async function refuseOutsideWrite(
  s: CliServices,
  workspaceId: string,
  asked: string,
  absolute: string,
): Promise<void> {
  if (!namesNetworkPath(asked, absolute)) return;
  const folders = await workspaceFolders(s, workspaceId);
  refuseOutsideRead(process.platform === "win32", folders, asked, absolute, "written");
}

export async function serveFileDestination(
  s: CliServices,
  request: RemoteServeRequest,
  watches: RemoteServeOptions,
  fileWrites: FileWrites,
  checkCurrent: () => void,
  by: AgentSender | undefined,
) {
  const { from, method } = request;
  const write = request.params as RpcParams<"files.write.begin">;
  const workspace = workspaceOf(s, write.workspaceId);
  if (!workspace) throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
  const root = workspace.rootPath;
  const location = structuredClone(workspace.location);
  let approvedPath: string | undefined;
  const authorize = (destination?: string) => {
    checkCurrent();
    checkFileControl(write.anywhere, by, watches.agents, watches.controls?.());
    if (destination && approvedPath && destination !== approvedPath) {
      throw new RpcFailure(RpcErrorCode.Forbidden, "the approved destination changed");
    }
    const current = workspaceOf(s, write.workspaceId);
    if (!current || current.rootPath !== root || !isDeepStrictEqual(current.location, location)) {
      throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
    }
    if (write.anywhere && location.kind !== "local") {
      throw new RpcFailure(
        RpcErrorCode.Unavailable,
        "absolute file access requires a local workspace on the serving computer",
      );
    }
  };
  authorize();
  const directory = method === "files.mkdir";
  let agent: AgentFileWrites | undefined;
  if (location.kind !== "local") {
    const fs = await watches.files?.fs(write.workspaceId).catch(unavailable);
    if (!fs || fs.kind !== location.kind || !isAgentBackedProvider(fs)) {
      throw new RpcFailure(
        RpcErrorCode.Unavailable,
        "the workspace's filesystem agent is unavailable",
      );
    }
    agent = new AgentFileWrites(fs, root, write.path, directory);
  }
  if (write.anywhere) {
    await refuseOutsideWrite(s, write.workspaceId, write.path, absoluteFilePath(write.path));
  }
  approvedPath = await (agent?.resolve() ?? fileWriteDestination(root, write, directory));
  authorize();
  await watches.agents?.checkFile(
    s,
    {
      device: { id: from, name: watches.deviceName?.(from) ?? shortId(from) },
      method,
      params: write,
      ...lifetimeOf(request),
    },
    {
      path: approvedPath,
      tree: directory && write.transferId !== undefined,
      workspaceRoot: root,
    },
  );
  authorize();
  if (directory) {
    return agent ? agent.mkdir(approvedPath) : makeRemoteDirectory(root, write, authorize);
  }
  return fileWrites.begin(
    from,
    root,
    write,
    authorize,
    agent && { writer: agent, path: approvedPath },
  );
}

export async function serveFileRead(
  s: CliServices,
  request: RemoteServeRequest,
  watches: RemoteServeOptions,
  checkCurrent: () => void,
  by: AgentSender | undefined,
) {
  const { from, method } = request;
  if (!watches.files) {
    throw new RpcFailure(RpcErrorCode.MethodNotFound, `${request.method} is not served yet`);
  }
  const read = request.params as RpcParams<"files.list">;
  const { workspaceId, anywhere } = read;
  const workspace = workspaceOf(s, workspaceId);
  if (!workspace) throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
  const rootPath = workspace.rootPath;
  const location = structuredClone(workspace.location);
  const grant = method === "files.read" ? (read as RpcParams<"files.read">).grant : undefined;
  if (grant !== undefined) {
    if (anywhere) {
      throw new RpcFailure(RpcErrorCode.InvalidParams, "a grant is not taken with anywhere");
    }
    if (by) throw new RpcFailure(RpcErrorCode.Forbidden, "file grants are not taken from agents");
    if (!watches.fileGrants) throw grantExpired();
    if (read.path.includes("\0") || !isAbsoluteFor(rootPath, read.path)) {
      throw grantInvalid("a grant is for an absolute path");
    }
    const held = watches.fileGrants.check(grant, {
      device: from,
      epoch: request.epoch ?? "",
      workspaceId,
      rootPath,
      location,
      path: hostFilePath(rootPath, read.path),
    });
    const result = await readFile(
      { ...watches.files, folders: (id) => workspaceFolders(s, id) },
      rootPath,
      request.params as RpcParams<"files.read">,
      undefined,
      { path: held.path, realPath: held.realPath },
    );
    const current = workspaceOf(s, workspaceId);
    if (
      !current ||
      current.rootPath !== rootPath ||
      !isDeepStrictEqual(current.location, location)
    ) {
      throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
    }
    watches.fileGrants.touch(grant);
    return result;
  }
  const checkWorkspace = () => {
    const current = workspaceOf(s, workspaceId);
    if (
      !current ||
      current.rootPath !== rootPath ||
      !isDeepStrictEqual(current.location, location)
    ) {
      throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
    }
  };
  const authorizeAnywhere = () => {
    if (anywhere) {
      checkCurrent();
      checkFileControl(true, by, watches.agents, watches.controls?.());
      checkWorkspace();
      if (location.kind !== "local") {
        throw new RpcFailure(
          RpcErrorCode.Unavailable,
          "absolute file access requires a local workspace on the serving computer",
        );
      }
    }
  };
  const writeTarget = method === "files.list" && read.writeTarget === true;
  if (writeTarget && (!anywhere || !read.transferId)) {
    throw new RpcFailure(
      RpcErrorCode.InvalidParams,
      "a write target requires an absolute path and transfer ID",
    );
  }
  let approvedPath: string | undefined;
  if (anywhere) {
    authorizeAnywhere();
    const absolute = writeTarget ? absoluteFilePath(read.path) : absoluteReadPath(read.path, true);
    if (writeTarget) await refuseOutsideWrite(s, workspaceId, read.path, absolute);
    const network = !writeTarget && namesNetworkPath(read.path, absolute);
    const lookUp = () =>
      outsideFileSource(absolute)
        .then(async (path) => ({
          path,
          directory: method === "files.list" && (await stat(path)).isDirectory(),
        }))
        .catch((error: unknown) => ({ error }));
    const looked = network ? undefined : await lookUp();
    const target =
      looked && "path" in looked
        ? looked.path
        : writeTarget
          ? await fileWriteDestination(rootPath, read, true)
          : absolute;
    await watches.agents?.checkFile(
      s,
      {
        device: { id: from, name: watches.deviceName?.(from) ?? shortId(from) },
        method,
        params: { ...read, from: by as AgentSender },
        ...lifetimeOf(request),
      },
      {
        path: target,
        tree: looked
          ? writeTarget || ("directory" in looked && looked.directory)
          : method === "files.list",
        workspaceRoot: rootPath,
      },
    );
    authorizeAnywhere();
    const source = looked ?? (await lookUp());
    if ("error" in source) throw source.error;
    if (
      network &&
      (!namesNetworkPath(source.path) || networkRootOf(source.path) !== networkRootOf(absolute))
    ) {
      throw new RpcFailure(
        RpcErrorCode.Forbidden,
        `${read.path} leads off the network path that was allowed`,
      );
    }
    approvedPath = source.path;
    if (writeTarget) {
      if (!source.directory) {
        throw new RpcFailure(
          RpcErrorCode.InvalidParams,
          `${read.path} is a file: files.read reads it`,
        );
      }
      return { path: absolute, entries: [] };
    }
  }
  const files: RemoteFiles = {
    ...watches.files,
    folders: (id) => workspaceFolders(s, id),
    named: (id) =>
      outsideSetsOf(s, id).then((sets) => {
        if (by) return sets.agent;
        const legacy = (watches.legacyOutsideFiles?.() ?? true) && request.grants !== true;
        return legacy ? [...sets.standing, ...sets.files] : sets.standing;
      }),
  };
  if (request.method === "files.list") {
    const result = await listFiles(files, rootPath, read, approvedPath);
    authorizeAnywhere();
    if (by) watches.agents?.checkRead();
    checkCurrent();
    checkWorkspace();
    return result;
  }
  const result = await readFile(
    files,
    rootPath,
    request.params as RpcParams<"files.read">,
    approvedPath,
  );
  authorizeAnywhere();
  checkWorkspace();
  return result;
}

export async function serveFileSearch(
  s: CliServices,
  request: RemoteServeRequest,
  watches: RemoteServeOptions,
  searching: Map<string, number>,
) {
  const { from } = request;
  if (!watches.files) {
    throw new RpcFailure(RpcErrorCode.MethodNotFound, `${request.method} is not served yet`);
  }
  const { workspaceId } = request.params as { workspaceId: string };
  if (!workspaceOf(s, workspaceId)) {
    throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
  }
  const running = searching.get(from) ?? 0;
  if (running >= MAX_SEARCHES_PER_DEVICE) {
    throw new RpcFailure(
      RpcErrorCode.Unavailable,
      `that device has ${running} searches running here already: ask again once one ends`,
    );
  }
  searching.set(from, running + 1);
  try {
    const fs = await watches.files.fs(workspaceId).catch(unavailable);
    return await (request.method === "files.find"
      ? findFiles(fs, request.params as RpcParams<"files.find">)
      : searchFiles(fs, request.params as RpcParams<"files.search">));
  } finally {
    const left = (searching.get(from) ?? 1) - 1;
    if (left > 0) searching.set(from, left);
    else searching.delete(from);
  }
}

export const MAX_SEARCHES_PER_DEVICE = 2;
