/**
 * TagPickerSource — Quick-pick PaletteSource for tag management.
 *
 * The browse picker opens with all local tags (`searchOnEmptyQuery`) plus a
 * create row. Focused menu modes keep the same search UX while swapping only
 * the data source, accept handler, and palette copy:
 *
 *   - `browse`        → reveal local tags.
 *   - `create`        → typed query opens the create dialog; local tags are context.
 *   - `delete-local`  → local tag rows open a local delete confirmation.
 *   - `delete-remote` → selected-remote tag rows open a remote delete confirmation.
 */
import type { RemoteTag, Tag } from "../../../../../shared/types/git";
import type { PaletteItem, PaletteSource } from "../../../ui/palette/types";

export type TagPickerMode = "browse" | "create" | "delete-local" | "delete-remote";

export type TagDeleteTarget = { kind: "local" } | { kind: "remote"; remote: string };

export type LocalTagPickItem = PaletteItem & {
  kind: "tag";
  tag: Tag;
  scope: "local";
};

export type RemoteTagPickItem = PaletteItem & {
  kind: "tag";
  tag: RemoteTag;
  scope: "remote";
  remote: string;
};

export type TagPickItem =
  | LocalTagPickItem
  | RemoteTagPickItem
  | (PaletteItem & {
      kind: "create";
      defaultName?: string;
    });

export interface CreateTagPickerSourceInput {
  workspaceId: string;
  mode?: TagPickerMode;
  selectedRemote?: string | null;
  listTags: (workspaceId: string, signal?: AbortSignal) => Promise<Tag[] | undefined>;
  listRemoteTags: (
    workspaceId: string,
    remote: string,
    signal?: AbortSignal,
  ) => Promise<RemoteTag[] | undefined>;
  revealTag: (item: LocalTagPickItem) => void;
  requestCreate: (defaultName?: string) => void;
  requestDelete: (item: LocalTagPickItem | RemoteTagPickItem, target: TagDeleteTarget) => void;
}

/**
 * Builds the tag picker source consumed by CommandPalette.
 */
export function createTagPickerSource(
  input: CreateTagPickerSourceInput,
): PaletteSource<TagPickItem> {
  const mode = input.mode ?? "browse";
  const copy = tagPickerCopy(mode);

  return {
    id: "git.tag-picker",
    title: copy.title,
    placeholder: copy.placeholder,
    emptyQueryMessage: copy.emptyQueryMessage,
    noResultsMessage: copy.noResultsMessage,
    searchOnEmptyQuery: true,

    async search(query, signal): Promise<readonly TagPickItem[]> {
      const trimmed = query.trim();
      const lowerQuery = trimmed.toLowerCase();

      if (mode === "delete-remote") {
        const remote = normalizeSelectedRemote(input.selectedRemote);
        if (!remote) return [];

        const remoteTags = await input.listRemoteTags(input.workspaceId, remote, signal);
        if (signal.aborted || !remoteTags) return [];
        return remoteTagItemsForMode(remoteTags, lowerQuery);
      }

      const tags = await input.listTags(input.workspaceId, signal);
      if (signal.aborted || !tags) return [];

      const tagItems = localTagItemsForMode({ tags, mode, lowerQuery, query: trimmed });

      if (mode === "browse") {
        return [createTagItem(trimmed), ...tagItems];
      }
      if (mode === "create" && trimmed.length > 0) {
        return [createTagItem(trimmed), ...tagItems];
      }
      return tagItems;
    },

    accept(item, _context): void {
      if (item.kind === "create") {
        input.requestCreate(item.defaultName);
        return;
      }

      if (mode === "create") {
        return;
      }
      if (mode === "delete-local" && item.scope === "local") {
        input.requestDelete(item, { kind: "local" });
        return;
      }
      if (mode === "delete-remote" && item.scope === "remote") {
        input.requestDelete(item, { kind: "remote", remote: item.remote });
        return;
      }

      if (item.scope === "local") input.revealTag(item);
    },
  };
}

/**
 * Builds local tag rows for modes backed by the local-only `listTags` path.
 */
function localTagItemsForMode({
  tags,
  mode,
  lowerQuery,
  query,
}: {
  tags: readonly Tag[];
  mode: Exclude<TagPickerMode, "delete-remote">;
  lowerQuery: string;
  query: string;
}): LocalTagPickItem[] {
  const sorted = [...tags].sort((a, b) => a.name.localeCompare(b.name));
  return sorted
    .map((tag) => localTagToItem(tag, { mode, query }))
    .filter((item) => matchesTagQuery(item, lowerQuery));
}

/**
 * Builds selected-remote tag rows from truthful `ls-remote` payloads.
 */
function remoteTagItemsForMode(
  tags: readonly RemoteTag[],
  lowerQuery: string,
): RemoteTagPickItem[] {
  const sorted = [...tags].sort((a, b) => a.name.localeCompare(b.name));
  return sorted.map(remoteTagToItem).filter((item) => matchesTagQuery(item, lowerQuery));
}

/**
 * Returns the mode-specific palette chrome and empty-state copy.
 */
function tagPickerCopy(
  mode: TagPickerMode,
): Pick<
  PaletteSource<TagPickItem>,
  "title" | "placeholder" | "emptyQueryMessage" | "noResultsMessage"
> {
  switch (mode) {
    case "create":
      return {
        title: "Create a new tag",
        placeholder: "Type a tag name to create…",
        emptyQueryMessage: "Loading tags…",
        noResultsMessage: "Type to create your first tag",
      };
    case "delete-local":
      return {
        title: "Select a tag to delete",
        placeholder: "Search local tags…",
        emptyQueryMessage: "Loading local tags…",
        noResultsMessage: "No tags to delete",
      };
    case "delete-remote":
      return {
        title: "Select a remote tag to delete",
        placeholder: "Search remote tags…",
        emptyQueryMessage: "Loading remote tags…",
        noResultsMessage: "No remote tags to delete",
      };
    case "browse":
      return {
        title: "Tags",
        placeholder: "Search tags or type a name to create…",
        emptyQueryMessage: "Loading tags…",
        noResultsMessage: "No matching tags.",
      };
  }
}

/**
 * Converts a local tag into the palette row shape for the selected mode.
 */
function localTagToItem(
  tag: Tag,
  options: { mode: Exclude<TagPickerMode, "delete-remote">; query?: string },
): LocalTagPickItem {
  const formatted = tag.message ?? formatTagDate(tag);
  const exactCreateConflict =
    options.mode === "create" &&
    options.query !== undefined &&
    options.query.length > 0 &&
    tag.name.toLowerCase() === options.query.toLowerCase();
  const modeDetail = detailForLocalMode(options.mode, formatted, exactCreateConflict);
  const kindLabel = kindLabelForLocalMode(options.mode, tag.type, exactCreateConflict);
  const destructive = options.mode === "delete-local";

  return {
    id: `tag:${tag.name}:${tag.sha}`,
    label: tag.name,
    description: formatted,
    ...(modeDetail ? { detail: modeDetail } : {}),
    kindLabel,
    ariaLabel: ariaLabelForLocalMode(options.mode, tag.name),
    tooltip: tooltipForLocalMode(options.mode),
    ...(destructive ? { tone: "destructive" as const } : {}),
    kind: "tag",
    scope: "local",
    tag,
  };
}

/**
 * Converts a selected-remote tag row into a destructive palette item.
 */
function remoteTagToItem(tag: RemoteTag): RemoteTagPickItem {
  const formatted = formatRemoteTag(tag);
  return {
    id: `tag:remote:${tag.remote}:${tag.name}:${tag.sha}`,
    label: `${tag.remote}/${tag.name}`,
    description: formatted,
    detail: `Remote ${tag.remote} · ${formatted}`,
    kindLabel: "delete",
    ariaLabel: `Delete remote tag ${tag.remote}/${tag.name}`,
    tooltip: `Delete remote tag on ${tag.remote}`,
    tone: "destructive",
    kind: "tag",
    scope: "remote",
    remote: tag.remote,
    tag,
  };
}

/**
 * Builds the synthetic create row. Non-empty queries become a suggested tag
 * name so "type name → Enter" opens the FormDialog prefilled.
 */
function createTagItem(query: string): Extract<TagPickItem, { kind: "create" }> {
  return {
    id: query ? `create:${query}` : "create",
    label: query ? `Create tag: '${query}'` : "Create tag…",
    kindLabel: "+",
    ariaLabel: query ? `Create tag ${query}` : "Create tag",
    kind: "create",
    ...(query ? { defaultName: query } : {}),
  };
}

/**
 * Returns mode-specific secondary text for local rows.
 */
function detailForLocalMode(
  mode: Exclude<TagPickerMode, "delete-remote">,
  formatted: string,
  exactCreateConflict: boolean,
): string | undefined {
  switch (mode) {
    case "create":
      return `${exactCreateConflict ? "Already exists" : "Existing tag"} · ${formatted}`;
    case "delete-local":
      return `Local tag · ${formatted}`;
    case "browse":
      return undefined;
  }
}

/**
 * Returns the compact right-side row label supported by the palette model.
 */
function kindLabelForLocalMode(
  mode: Exclude<TagPickerMode, "delete-remote">,
  tagType: Tag["type"],
  exactCreateConflict: boolean,
): string {
  if (mode === "delete-local") return "delete";
  if (mode === "create" && exactCreateConflict) return "exists";
  return tagType;
}

/**
 * Builds an accessible action label for local tag rows.
 */
function ariaLabelForLocalMode(
  mode: Exclude<TagPickerMode, "delete-remote">,
  name: string,
): string {
  switch (mode) {
    case "delete-local":
      return `Delete local tag ${name}`;
    case "create":
      return `Existing tag ${name}`;
    case "browse":
      return `${name} tag`;
  }
}

/**
 * Describes local row intent through the palette's current tooltip channel.
 */
function tooltipForLocalMode(mode: Exclude<TagPickerMode, "delete-remote">): string | undefined {
  switch (mode) {
    case "create":
      return "Existing tag shown for conflict context";
    case "delete-local":
      return "Delete local tag";
    case "browse":
      return undefined;
  }
}

/**
 * Case-insensitive query matcher spanning tag label, remote, message, SHA, and type.
 */
function matchesTagQuery(item: LocalTagPickItem | RemoteTagPickItem, lowerQuery: string): boolean {
  if (lowerQuery.length === 0) return true;
  const values =
    item.scope === "remote"
      ? [item.label, item.remote, item.tag.name, item.tag.sha, item.scope]
      : [item.label, item.tag.name, item.tag.sha, item.tag.message ?? "", item.tag.type];
  return values.some((value) => value.toLowerCase().includes(lowerQuery));
}

/**
 * Normalizes the selected remote before delete-remote listing.
 */
function normalizeSelectedRemote(remote: string | null | undefined): string | null {
  const trimmed = remote?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Formats remote tag metadata with the only stable field from `ls-remote`.
 */
function formatRemoteTag(tag: RemoteTag): string {
  return tag.sha.slice(0, 7);
}

/**
 * Formats tag timestamps with a stable fallback for lightweight tags.
 */
function formatTagDate(tag: Tag): string {
  if (tag.taggerDate === null) return `${tag.sha.slice(0, 7)} · no tagger date`;
  return `${relativeTime(tag.taggerDate)} · ${tag.sha.slice(0, 7)}`;
}

/**
 * Formats a compact client-side relative timestamp for tag descriptions.
 */
function relativeTime(timestamp: number, now: number = Date.now()): string {
  const diffMs = Math.max(0, now - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diffMs < minute) return "just now";
  if (diffMs < hour) return `${Math.floor(diffMs / minute)}m ago`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`;
  return `${Math.floor(diffMs / day)}d ago`;
}
