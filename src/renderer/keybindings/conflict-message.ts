import type { TFunction } from "i18next";
import type { KeybindingConflict } from "../../shared/keybindings/conflicts";
import { EDITOR_COMMANDS } from "../../shared/keybindings/editor-commands";

const EDITOR_SLUGS = new Map(EDITOR_COMMANDS.map((c) => [c.id, c.slug]));

export function keybindingCommandLabel(t: TFunction<"settings">, id: string): string {
  const slug = EDITOR_SLUGS.get(id);
  return slug === undefined
    ? t(`keybindings.command.${id}` as never)
    : t(`keybindings.editorCommand.${slug}` as never);
}

export function keybindingConflictMessage(
  t: TFunction<"settings">,
  conflict: KeybindingConflict,
): string {
  const note = conflict.reserved
    ? t(`keybindings.reservedNote.${conflict.reserved.noteKey}` as never)
    : "";
  if (conflict.kind === "blocking" || conflict.kind === "overlap") {
    return t(`keybindings.conflict.${conflict.kind}`, {
      command: conflict.command !== undefined ? keybindingCommandLabel(t, conflict.command) : "?",
    });
  }
  if (conflict.kind === "system") return t("keybindings.conflict.system", { note });
  return t("keybindings.conflict.shadow", {
    owner:
      conflict.reserved !== undefined ? t(`keybindings.owner.${conflict.reserved.source}`) : "?",
    note,
  });
}
