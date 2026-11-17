/**
 * The text in a tab's rename box. It starts from what the tab is called
 * when editing starts and from then on holds only what is typed: a
 * terminal's title can change mid-edit (a shell sets it per command), and
 * that must not wipe the name being typed.
 */
export interface RenameDraft {
  /** Whether the tab was being renamed when this text was set. */
  readonly editing: boolean;
  readonly value: string;
}

/**
 * The draft for a render: a new one from `title` when editing has just
 * started, otherwise `draft` itself (the same object, so a caller that keeps
 * it in state sets nothing).
 */
export function followRenameDraft(
  draft: RenameDraft,
  isEditing: boolean,
  title: string,
): RenameDraft {
  if (isEditing === draft.editing) return draft;
  return isEditing ? { editing: true, value: title } : { editing: false, value: draft.value };
}
