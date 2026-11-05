// A Jupyter notebook (.ipynb, nbformat 4) as one Markdown document, for
// the Markdown preview to draw.
//
// Markdown cells go in as they are. A code cell becomes a fenced block in
// the notebook's language under its "In [n]:" prompt, and each of its
// outputs follows: text and errors as plain blocks, with terminal colour
// codes and carriage-return redraws (progress bars) resolved; images as
// images; HTML (a DataFrame's table) as HTML, which the preview sanitizes
// as it does any HTML in Markdown; Markdown as Markdown; JSON as a JSON
// block. Images are not written into the text, which the Markdown parser
// would have to step through: each is named by a placeholder source that
// `images` maps to its data URL. The placeholder is a fragment, which the
// sanitizer keeps where it drops a source of an unknown scheme.

export interface NotebookDocument {
  readonly markdown: string;
  /** Each image's placeholder source, to the data URL it stands for. */
  readonly images: ReadonlyMap<string, string>;
}

/** A notebook that cannot be read: not JSON, or not nbformat 4. */
export class NotebookError extends Error {
  constructor(readonly reason: "not_json" | "unsupported") {
    super(reason);
    this.name = "NotebookError";
  }
}

/** Placeholder sources start with this; the Markdown preview looks them up. */
export const NOTEBOOK_IMAGE_PREFIX = "#nb-image-";

/** An output's kinds of data, in the order the first one present is shown. */
const RASTER = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
/** Terminal escape sequences: colours (CSI), titles and links (OSC), and the rest. */
const ANSI = new RegExp(
  `${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?|${ESC}[@-_]`,
  "g",
);

type Json = unknown;

function isRecord(value: Json): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** nbformat's multiline strings: one string, or a list of lines. */
function text(value: Json): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((line) => typeof line === "string").join("");
  return "";
}

/** Text as a terminal leaves it: no escape codes, and a line redrawn after `\r` shows its last state. */
export function terminalText(value: string): string {
  return value
    .replace(ANSI, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n");
}

/** A fenced block of `body`, its fence longer than any run of backticks in it. */
function fenced(body: string, language = ""): string {
  let longest = 0;
  for (const run of body.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${body.replace(/\n$/, "")}\n${fence}`;
}

/** A small prompt line, as Jupyter shows beside a cell. */
function prompt(label: string, count: Json): string {
  const n = typeof count === "number" ? String(count) : "&nbsp;";
  return `<sub>${label}&nbsp;[${n}]:</sub>`;
}

/**
 * HTML as one raw block: its styles and scripts dropped (the sanitizer
 * would leave a style's text in place), and no blank line in it, which
 * would end the block and read the rest as Markdown.
 */
function htmlBlock(html: string): string {
  const body = html
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/\n[ \t]*(?=\n)/g, "");
  return `<div>\n${body.trim()}\n</div>`;
}

export function notebookToMarkdown(source: string): NotebookDocument {
  let notebook: Json;
  try {
    notebook = JSON.parse(source);
  } catch {
    throw new NotebookError("not_json");
  }
  if (!isRecord(notebook) || !Array.isArray(notebook.cells)) {
    throw new NotebookError("unsupported");
  }

  const metadata = isRecord(notebook.metadata) ? notebook.metadata : {};
  const languageInfo = isRecord(metadata.language_info) ? metadata.language_info : {};
  const kernelspec = isRecord(metadata.kernelspec) ? metadata.kernelspec : {};
  const languageName =
    typeof languageInfo.name === "string"
      ? languageInfo.name
      : typeof kernelspec.language === "string"
        ? kernelspec.language
        : "python";
  // A fence's info string ends at a space, and a backtick would end the fence.
  const language = languageName.toLowerCase().replace(/[\s`]+/g, "");

  const images = new Map<string, string>();
  const image = (url: string): string => {
    const key = `${NOTEBOOK_IMAGE_PREFIX}${images.size}`;
    images.set(key, url);
    return `![](${key})`;
  };

  /** The Markdown for one output's data, or none for data not shown. */
  const data = (bundle: Record<string, Json>): string | null => {
    const html = text(bundle["text/html"]);
    const raster = RASTER.find((mime) => text(bundle[mime]));
    // Scripted HTML (an interactive chart) draws nothing here; its picture does.
    if (html && !(raster && /<script\b/i.test(html))) return htmlBlock(html);
    if (raster) return image(`data:${raster};base64,${text(bundle[raster]).replace(/\s+/g, "")}`);
    const svg = text(bundle["image/svg+xml"]);
    if (svg) return image(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    const markdown = text(bundle["text/markdown"]);
    if (markdown) return markdown;
    const latex = text(bundle["text/latex"]);
    if (latex) return latex;
    if (bundle["application/json"] !== undefined) {
      return fenced(JSON.stringify(bundle["application/json"], null, 2), "json");
    }
    const plain = text(bundle["text/plain"]);
    if (plain) return fenced(terminalText(plain));
    return null;
  };

  const blocks: string[] = [];
  for (const cell of notebook.cells) {
    if (!isRecord(cell)) continue;
    const body = text(cell.source);
    if (cell.cell_type === "markdown") {
      let markdown = body;
      // Images attached to the cell are named `attachment:<name>` in it.
      if (isRecord(cell.attachments)) {
        for (const [name, bundle] of Object.entries(cell.attachments)) {
          if (!isRecord(bundle)) continue;
          const mime = [...RASTER, "image/svg+xml"].find((m) => text(bundle[m]));
          if (!mime) continue;
          const payload = text(bundle[mime]).replace(/\s+/g, "");
          const key = `${NOTEBOOK_IMAGE_PREFIX}${images.size}`;
          images.set(key, `data:${mime};base64,${payload}`);
          markdown = markdown.split(`attachment:${name}`).join(key);
        }
      }
      if (markdown.trim()) blocks.push(markdown);
      continue;
    }
    if (cell.cell_type === "raw") {
      if (body.trim()) blocks.push(fenced(body));
      continue;
    }
    if (cell.cell_type !== "code") continue;

    const outputs = Array.isArray(cell.outputs) ? cell.outputs.filter(isRecord) : [];
    if (!body.trim() && outputs.length === 0) continue;
    blocks.push(`${prompt("In", cell.execution_count)}\n\n${fenced(body, language)}`);
    for (const output of outputs) {
      switch (output.output_type) {
        case "stream": {
          const stream = terminalText(text(output.text));
          if (stream.trim()) blocks.push(fenced(stream));
          break;
        }
        case "error": {
          const traceback = Array.isArray(output.traceback)
            ? output.traceback.filter((line) => typeof line === "string").join("\n")
            : `${text(output.ename)}: ${text(output.evalue)}`;
          blocks.push(fenced(terminalText(traceback)));
          break;
        }
        case "execute_result":
        case "display_data": {
          const shown = isRecord(output.data) ? data(output.data) : null;
          if (shown === null) break;
          if (output.output_type === "execute_result") {
            blocks.push(`${prompt("Out", output.execution_count)}\n\n${shown}`);
          } else {
            blocks.push(shown);
          }
          break;
        }
      }
    }
  }
  return { markdown: blocks.join("\n\n"), images };
}
