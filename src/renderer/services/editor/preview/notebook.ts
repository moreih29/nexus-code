export interface NotebookDocument {
  readonly markdown: string;
  readonly images: ReadonlyMap<string, string>;
}

export class NotebookError extends Error {
  constructor(readonly reason: "not_json" | "unsupported") {
    super(reason);
    this.name = "NotebookError";
  }
}

export const NOTEBOOK_IMAGE_PREFIX = "#nb-image-";

const RASTER = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const ANSI = new RegExp(
  `${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?|${ESC}[@-_]`,
  "g",
);

type Json = unknown;

function isRecord(value: Json): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: Json): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((line) => typeof line === "string").join("");
  return "";
}

export function terminalText(value: string): string {
  return value
    .replace(ANSI, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n");
}

function fenced(body: string, language = ""): string {
  let longest = 0;
  for (const run of body.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${body.replace(/\n$/, "")}\n${fence}`;
}

function prompt(label: string, count: Json): string {
  const n = typeof count === "number" ? String(count) : "&nbsp;";
  return `<sub>${label}&nbsp;[${n}]:</sub>`;
}

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
  const language = languageName.toLowerCase().replace(/[\s`]+/g, "");

  const images = new Map<string, string>();
  const image = (url: string): string => {
    const key = `${NOTEBOOK_IMAGE_PREFIX}${images.size}`;
    images.set(key, url);
    return `![](${key})`;
  };

  const data = (bundle: Record<string, Json>): string | null => {
    const html = text(bundle["text/html"]);
    const raster = RASTER.find((mime) => text(bundle[mime]));
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
