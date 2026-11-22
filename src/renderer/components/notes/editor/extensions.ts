/** The note editor's TipTap extensions. */
import { type AnyExtension, Extension } from "@tiptap/core";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extensions";
import StarterKit from "@tiptap/starter-kit";
import { NoteFile, NoteImage } from "./asset-nodes";
import type { NoteHost } from "./host";
import { Sketch } from "./sketch-node";
import { SlashMenu, type SlashMenuOptions } from "./slash-menu";
import { NoteSummaryDivider } from "./summary-divider";

const summaryAttribute = {
  default: null,
  keepOnSplit: false,
  rendered: false,
  parseHTML: () => null,
};

const NoteSummaryAttributes = Extension.create({
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
  ],
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
        // workspace:<path>: a file of the workspace, linked from the file tree.
        protocols: [{ scheme: "workspace", optionalSlashes: true }],
      },
      heading: { levels: [1, 2, 3] },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    NoteSummaryAttributes,
    NoteSummaryDivider,
    Placeholder.configure({ placeholder: options.placeholder }),
    Sketch.configure({ host }),
    NoteImage.configure({ host }),
    NoteFile.configure({ host }),
    SlashMenu.configure({ pickFiles: options.pickFiles, pickImages: options.pickImages }),
  ];
}
