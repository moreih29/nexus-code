export interface RenameDraft {
  readonly editing: boolean;
  readonly value: string;
}

export function followRenameDraft(
  draft: RenameDraft,
  isEditing: boolean,
  title: string,
): RenameDraft {
  if (isEditing === draft.editing) return draft;
  return isEditing ? { editing: true, value: title } : { editing: false, value: draft.value };
}
