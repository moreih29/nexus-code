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
import i18next from "i18next";
import type { RemoteTag, Tag } from "../../../../../shared/git/types";
import type { PaletteItem, PaletteSource } from "../../../ui/palette/types";
import { relativeTime } from "../utils/relative-time";

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
  const t = i18next.t.bind(i18next);
  switch (mode) {
    case "create":
      return {
        title: t("files:git.tagPicker.createTitle"),
        placeholder: t("files:git.tagPicker.createPlaceholder"),
        emptyQueryMessage: t("files:git.tagPicker.loadingTags"),
        noResultsMessage: t("files:git.tagPicker.typeForFirst"),
      };
    case "delete-local":
      return {
        title: t("files:git.tagPicker.deleteLocalTitle"),
        placeholder: t("files:git.tagPicker.deleteLocalPlaceholder"),
        emptyQueryMessage: t("files:git.tagPicker.loadingLocalTags"),
        noResultsMessage: t("files:git.tagPicker.noTagsToDelete"),
      };
    case "delete-remote":
      return {
        title: t("files:git.tagPicker.deleteRemoteTitle"),
        placeholder: t("files:git.tagPicker.deleteRemotePlaceholder"),
        emptyQueryMessage: t("files:git.tagPicker.loadingRemoteTags"),
        noResultsMessage: t("files:git.tagPicker.noRemoteTagsToDelete"),
      };
    case "browse":
      return {
        title: t("files:git.tagPicker.browseTitle"),
        placeholder: t("files:git.tagPicker.browsePlaceholder"),
        emptyQueryMessage: t("files:git.tagPicker.loadingTags"),
        noResultsMessage: t("files:git.tagPicker.noMatchingTags"),
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
  const t = i18next.t.bind(i18next);
  const formatted = formatRemoteTag(tag);
  return {
    id: `tag:remote:${tag.remote}:${tag.name}:${tag.sha}`,
    label: `${tag.remote}/${tag.name}`,
    description: formatted,
    detail: `Remote ${tag.remote} · ${formatted}`,
    kindLabel: "delete",
    ariaLabel: t("files:git.tagPicker.deleteRemoteTagAria", { remote: tag.remote, name: tag.name }),
    tooltip: t("files:git.tagPicker.deleteRemoteTagTooltip", { remote: tag.remote }),
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
  const t = i18next.t.bind(i18next);
  return {
    id: query ? `create:${query}` : "create",
    label: query ? t("files:git.tagPicker.createRow", { name: query }) : t("files:git.tagPicker.createRowEmpty"),
    kindLabel: "+",
    ariaLabel: query ? t("files:git.tagPicker.createRow", { name: query }) : t("files:git.tagPicker.createRowEmpty"),
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
  const t = i18next.t.bind(i18next);
  switch (mode) {
    case "create":
      return `${exactCreateConflict ? t("files:git.tagPicker.alreadyExists") : t("files:git.tagPicker.existingTag")} · ${formatted}`;
    case "delete-local":
      return `${t("files:git.tagPicker.localTag")} · ${formatted}`;
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
  const t = i18next.t.bind(i18next);
  switch (mode) {
    case "delete-local":
      return t("files:git.tagPicker.deleteLocalTag", { name });
    case "create":
      return t("files:git.tagPicker.existingTagAria", { name });
    case "browse":
      return t("files:git.tagPicker.tagAria", { name });
  }
}

/**
 * Describes local row intent through the palette's current tooltip channel.
 */
function tooltipForLocalMode(mode: Exclude<TagPickerMode, "delete-remote">): string | undefined {
  const t = i18next.t.bind(i18next);
  switch (mode) {
    case "create":
      return t("files:git.tagPicker.existingTagTooltip");
    case "delete-local":
      return t("files:git.tagPicker.deleteLocalTagTooltip");
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
  const t = i18next.t.bind(i18next);
  if (tag.taggerDate === null) return `${tag.sha.slice(0, 7)} · ${t("files:git.tagPicker.noTaggerDate")}`;
  return `${relativeTime(tag.taggerDate)} · ${tag.sha.slice(0, 7)}`;
}

