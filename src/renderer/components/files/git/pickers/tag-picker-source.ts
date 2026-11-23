import i18next from "i18next";
import type { RemoteTag, Tag } from "../../../../../shared/git/types";
import { relativeTime } from "../../../../utils/time-format";
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

function remoteTagItemsForMode(
  tags: readonly RemoteTag[],
  lowerQuery: string,
): RemoteTagPickItem[] {
  const sorted = [...tags].sort((a, b) => a.name.localeCompare(b.name));
  return sorted.map(remoteTagToItem).filter((item) => matchesTagQuery(item, lowerQuery));
}

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

function remoteTagToItem(tag: RemoteTag): RemoteTagPickItem {
  const t = i18next.t.bind(i18next);
  const formatted = formatRemoteTag(tag);
  return {
    id: `tag:remote:${tag.remote}:${tag.name}:${tag.sha}`,
    label: `${tag.remote}/${tag.name}`,
    description: formatted,
    detail: `Remote ${tag.remote} · ${formatted}`,
    kindLabel: t("files:git.pickerKind.delete"),
    ariaLabel: t("files:git.tagPicker.deleteRemoteTagAria", { remote: tag.remote, name: tag.name }),
    tooltip: t("files:git.tagPicker.deleteRemoteTagTooltip", { remote: tag.remote }),
    tone: "destructive",
    kind: "tag",
    scope: "remote",
    remote: tag.remote,
    tag,
  };
}

function createTagItem(query: string): Extract<TagPickItem, { kind: "create" }> {
  const t = i18next.t.bind(i18next);
  return {
    id: query ? `create:${query}` : "create",
    label: query
      ? t("files:git.tagPicker.createRow", { name: query })
      : t("files:git.tagPicker.createRowEmpty"),
    kindLabel: "+",
    ariaLabel: query
      ? t("files:git.tagPicker.createRow", { name: query })
      : t("files:git.tagPicker.createRowEmpty"),
    kind: "create",
    ...(query ? { defaultName: query } : {}),
  };
}

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

function kindLabelForLocalMode(
  mode: Exclude<TagPickerMode, "delete-remote">,
  tagType: Tag["type"],
  exactCreateConflict: boolean,
): string {
  const t = i18next.t.bind(i18next);
  if (mode === "delete-local") return t("files:git.pickerKind.delete");
  if (mode === "create" && exactCreateConflict) return t("files:git.pickerKind.exists");
  return t(`files:git.pickerKind.${tagType}`);
}

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

function matchesTagQuery(item: LocalTagPickItem | RemoteTagPickItem, lowerQuery: string): boolean {
  if (lowerQuery.length === 0) return true;
  const values =
    item.scope === "remote"
      ? [item.label, item.remote, item.tag.name, item.tag.sha, item.scope]
      : [item.label, item.tag.name, item.tag.sha, item.tag.message ?? "", item.tag.type];
  return values.some((value) => value.toLowerCase().includes(lowerQuery));
}

function normalizeSelectedRemote(remote: string | null | undefined): string | null {
  const trimmed = remote?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function formatRemoteTag(tag: RemoteTag): string {
  return tag.sha.slice(0, 7);
}

function formatTagDate(tag: Tag): string {
  const t = i18next.t.bind(i18next);
  if (tag.taggerDate === null)
    return `${tag.sha.slice(0, 7)} · ${t("files:git.tagPicker.noTaggerDate")}`;
  return `${relativeTime(tag.taggerDate)} · ${tag.sha.slice(0, 7)}`;
}
