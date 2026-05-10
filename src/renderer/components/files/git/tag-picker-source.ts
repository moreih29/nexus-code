/**
 * TagPickerSource — Quick-pick PaletteSource for local tag management.
 *
 * The picker opens with all tags (`searchOnEmptyQuery`) plus a create row.
 * Modifier accepts route destructive actions through the dialog owner:
 *
 *   - Enter                         → reveal the tag in the History panel.
 *   - Cmd/Ctrl+Backspace            → delete local tag.
 *   - Shift+Cmd/Ctrl+Backspace      → delete local tag and remote tag.
 */
import type { Tag } from "../../../../shared/types/git";
import type { PaletteItem, PaletteSource } from "../../ui/palette/types";

export type TagPickItem =
  | (PaletteItem & {
      kind: "tag";
      tag: Tag;
    })
  | (PaletteItem & {
      kind: "create";
      defaultName?: string;
    });

export interface CreateTagPickerSourceInput {
  workspaceId: string;
  listTags: (workspaceId: string, signal?: AbortSignal) => Promise<Tag[] | undefined>;
  revealTag: (item: Extract<TagPickItem, { kind: "tag" }>) => void;
  requestCreate: (defaultName?: string) => void;
  requestDelete: (item: Extract<TagPickItem, { kind: "tag" }>, includeRemote: boolean) => void;
}

/**
 * Builds the tag picker source consumed by CommandPalette.
 */
export function createTagPickerSource(
  input: CreateTagPickerSourceInput,
): PaletteSource<TagPickItem> {
  return {
    id: "git.tag-picker",
    title: "Tags",
    placeholder: "Search tags or type a name to create…",
    emptyQueryMessage: "Loading tags…",
    noResultsMessage: "No matching tags.",
    searchOnEmptyQuery: true,

    async search(query, signal): Promise<readonly TagPickItem[]> {
      const tags = await input.listTags(input.workspaceId, signal);
      if (signal.aborted || !tags) return [];

      const trimmed = query.trim();
      const lowerQuery = trimmed.toLowerCase();
      const tagItems = [...tags]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(tagToItem)
        .filter((item) => matchesTagQuery(item, lowerQuery));

      return [createTagItem(trimmed), ...tagItems];
    },

    accept(item, context): void {
      if (item.kind === "create") {
        input.requestCreate(item.defaultName);
        return;
      }

      const metaOrCtrl = context?.modifiers?.meta === true || context?.modifiers?.ctrl === true;
      if (metaOrCtrl && isDeleteKey(context?.key)) {
        input.requestDelete(item, context?.modifiers?.shift === true);
        return;
      }

      input.revealTag(item);
    },
  };
}

/**
 * Converts a tag into the palette row shape.
 */
function tagToItem(tag: Tag): Extract<TagPickItem, { kind: "tag" }> {
  return {
    id: `tag:${tag.name}:${tag.sha}`,
    label: tag.name,
    description: tag.message ?? formatTagDate(tag),
    kindLabel: tag.type,
    ariaLabel: `${tag.name} ${tag.type} tag`,
    kind: "tag",
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
 * Case-insensitive query matcher spanning tag name, message, SHA, and type.
 */
function matchesTagQuery(item: Extract<TagPickItem, { kind: "tag" }>, lowerQuery: string): boolean {
  if (lowerQuery.length === 0) return true;
  return [item.tag.name, item.tag.sha, item.tag.message ?? "", item.tag.type].some((value) =>
    value.toLowerCase().includes(lowerQuery),
  );
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

/**
 * Checks whether an accept came from the destructive tag shortcut.
 */
function isDeleteKey(key: string | undefined): boolean {
  return key === "Backspace" || key === "Delete";
}
