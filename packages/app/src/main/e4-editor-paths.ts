import path from "node:path";

import { normalizeWorkspaceAbsolutePath } from "./workspace-persistence";

export interface E4ResolvedWorkspacePath {
  workspaceRoot: string;
  absolutePath: string;
  relativePath: string;
}

export interface E4ResolveWorkspacePathOptions {
  allowRoot?: boolean;
  fieldName?: string;
}

export function resolveE4WorkspacePath(
  workspaceRootInput: string,
  requestPathInput: string | null | undefined,
  options: E4ResolveWorkspacePathOptions = {},
): E4ResolvedWorkspacePath {
  const workspaceRoot = normalizeWorkspaceAbsolutePath(workspaceRootInput);
  const fieldName = options.fieldName ?? "path";
  const requestPath = requestPathInput ?? "";

  if (requestPath.includes("\0")) {
    throw new Error(`${fieldName} cannot contain NUL bytes.`);
  }

  if (isRendererSuppliedAbsolutePath(requestPath)) {
    throw new Error(`${fieldName} must be a workspace-relative path.`);
  }

  const normalizedRelativePath = normalizeRendererRelativePath(requestPath);
  if (normalizedRelativePath === "") {
    if (options.allowRoot) {
      return {
        workspaceRoot,
        absolutePath: workspaceRoot,
        relativePath: "",
      };
    }

    throw new Error(`${fieldName} cannot be empty.`);
  }

  if (normalizedRelativePath === ".." || normalizedRelativePath.startsWith("../")) {
    throw new Error(`${fieldName} cannot traverse outside the workspace.`);
  }

  const absolutePath = path.resolve(workspaceRoot, ...normalizedRelativePath.split("/"));
  assertPathInsideWorkspace(workspaceRoot, absolutePath, fieldName);

  return {
    workspaceRoot,
    absolutePath,
    relativePath: toWorkspaceRelativePath(workspaceRoot, absolutePath),
  };
}

export function toWorkspaceRelativePath(
  workspaceRootInput: string,
  absolutePathInput: string,
): string {
  const workspaceRoot = normalizeWorkspaceAbsolutePath(workspaceRootInput);
  const absolutePath = path.resolve(absolutePathInput);
  assertPathInsideWorkspace(workspaceRoot, absolutePath, "path");
  const relativePath = path.relative(workspaceRoot, absolutePath);
  return relativePath === "" ? "" : relativePath.split(path.sep).join("/");
}

function normalizeRendererRelativePath(requestPath: string): string {
  const slashNormalizedPath = requestPath.replace(/\\/g, "/").normalize("NFC");
  const normalizedPath = path.posix.normalize(slashNormalizedPath);
  return normalizedPath === "." ? "" : normalizedPath;
}

function isRendererSuppliedAbsolutePath(requestPath: string): boolean {
  const slashNormalizedPath = requestPath.replace(/\\/g, "/");
  return (
    path.isAbsolute(requestPath) ||
    path.posix.isAbsolute(slashNormalizedPath) ||
    path.win32.isAbsolute(requestPath) ||
    /^[A-Za-z]:/.test(requestPath)
  );
}

function assertPathInsideWorkspace(
  workspaceRoot: string,
  absolutePath: string,
  fieldName: string,
): void {
  const relativePath = path.relative(workspaceRoot, absolutePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`${fieldName} cannot traverse outside the workspace.`);
  }
}
