import { type AnyExtension, Extension } from "@tiptap/core";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extensions";
import StarterKit from "@tiptap/starter-kit";
import { NoteAnswerWidgets } from "./answer-card";
import { NoteFile, NoteImage } from "./asset-nodes";
import type { NoteHost } from "./host";
import { Sketch } from "./sketch-node";
import { SlashMenu, type SlashMenuOptions } from "./slash-menu";
import { NoteSummaryDivider } from "./summary-divider";
import { NoteTaskWidgets } from "./task-widgets";

const summaryAttribute = {
  default: null,
  keepOnSplit: false,
  rendered: false,
  parseHTML: () => null,
};

export const NoteSummaryAttributes = Extension.create({
  name: "noteSummaryAttributes",
  addGlobalAttributes: () => [
    {
      types: [
        "paragraph",
        "heading",
        "bulletList",
        "taskList",
        "orderedList",
        "listItem",
        "taskItem",
        "blockquote",
      ],
      attributes: {
        nexusOrigin: summaryAttribute,
      },
    },
    {
      types: ["taskItem"],
      attributes: {
        nexusSpeaker: summaryAttribute,
        nexusAt: summaryAttribute,
      },
    },
    {
      types: ["paragraph", "heading", "taskItem", "listItem", "blockquote"],
      attributes: {
        nexusLink: summaryAttribute,
      },
    },
  ],
});

export const NoteTaskItem = TaskItem.extend({
  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      Enter: () => {
        const origin = this.editor.state.selection.$from.parent.attrs.nexusOrigin;
        if (typeof origin !== "string" || !origin.startsWith("report:")) {
          return this.editor.commands.splitListItem(this.name);
        }
        return this.editor.commands.command(({ commands, tr }) => {
          if (!commands.splitListItem(this.name)) return false;
          const { $from } = tr.selection;
          if ($from.parent.attrs.nexusOrigin === origin) {
            tr.setNodeAttribute($from.before(), "nexusOrigin", null);
          }
          return true;
        });
      },
    };
  },
}).configure({
  nested: true,
  HTMLAttributes: { "data-type": "taskItem" },
});

export function noteExtensions(
  host: NoteHost,
  options: SlashMenuOptions & { placeholder: string },
): AnyExtension[] {
  return [
    StarterKit.configure({
      link: {
        openOnClick: false,
        autolink: true,
        defaultProtocol: "https",
        protocols: [{ scheme: "workspace", optionalSlashes: true }],
      },
      heading: { levels: [1, 2, 3] },
    }),
    TaskList,
    NoteTaskItem,
    NoteSummaryAttributes,
    NoteSummaryDivider,
    NoteTaskWidgets,
    NoteAnswerWidgets,
    Placeholder.configure({ placeholder: options.placeholder }),
    Sketch.configure({ host }),
    NoteImage.configure({ host }),
    NoteFile.configure({ host }),
    SlashMenu.configure({ pickFiles: options.pickFiles, pickImages: options.pickImages }),
  ];
}
