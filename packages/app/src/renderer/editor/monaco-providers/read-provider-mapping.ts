import type {
  LspDefinitionTarget,
  LspLocation,
  LspLocationLink,
  LspRange,
} from "../../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";

type MonacoApi = typeof import("monaco-editor");
type MonacoLocation = import("monaco-editor").languages.Location;
type MonacoLocationLink = import("monaco-editor").languages.LocationLink;

export function mapLspLocationToMonaco(
  monaco: MonacoApi,
  workspaceId: WorkspaceId,
  location: LspLocation,
): MonacoLocation {
  return {
    uri: uriForLspTarget(monaco, workspaceId, location.path, location.uri),
    range: mapRangeToMonaco(monaco, location.range),
  };
}

export function mapLspLocationLinkToMonaco(
  monaco: MonacoApi,
  workspaceId: WorkspaceId,
  locationLink: LspLocationLink,
): MonacoLocationLink {
  return {
    originSelectionRange: locationLink.originSelectionRange
      ? mapRangeToMonaco(monaco, locationLink.originSelectionRange)
      : undefined,
    uri: uriForLspTarget(
      monaco,
      workspaceId,
      locationLink.targetPath,
      locationLink.targetUri,
    ),
    range: mapRangeToMonaco(monaco, locationLink.targetRange),
    targetSelectionRange: mapRangeToMonaco(monaco, locationLink.targetSelectionRange),
  };
}

export function mapLspDefinitionTargetToMonaco(
  monaco: MonacoApi,
  workspaceId: WorkspaceId,
  target: LspDefinitionTarget,
): MonacoLocation | MonacoLocationLink {
  return target.type === "location-link"
    ? mapLspLocationLinkToMonaco(monaco, workspaceId, target)
    : mapLspLocationToMonaco(monaco, workspaceId, target);
}

export function mapRangeToMonaco(
  monaco: MonacoApi,
  range: LspRange,
): import("monaco-editor").Range {
  return new monaco.Range(
    range.start.line + 1,
    range.start.character + 1,
    range.end.line + 1,
    range.end.character + 1,
  );
}

export function uriForLspTarget(
  monaco: MonacoApi,
  workspaceId: WorkspaceId,
  path: string | null,
  fallbackUri: string,
): import("monaco-editor").Uri {
  if (!path) {
    return monaco.Uri.parse(fallbackUri);
  }

  return createNexusMonacoModelUri(monaco, workspaceId, path);
}

export function createNexusMonacoModelUri(
  monaco: MonacoApi,
  workspaceId: WorkspaceId | string,
  filePath: string,
): import("monaco-editor").Uri {
  const normalizedPath = filePath.split("/").map(encodeURIComponent).join("/");
  return monaco.Uri.parse(`file:///nexus/${encodeURIComponent(workspaceId)}/${normalizedPath}`);
}
