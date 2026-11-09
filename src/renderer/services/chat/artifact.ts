/**
 * The pages Claude publishes as Artifacts: claude.ai pages, private at
 * first, made from an HTML file it wrote here. A conversation shows each as
 * a card, drawn from the file it published, with the page on claude.ai a
 * click away, and the side panel lists them among what it made. Pure.
 */

import { baseName, resolveFilePath } from "./links";
import type { ToolCall } from "./model";

/** Claude Code's tool that publishes a page to claude.ai. */
export const ARTIFACT_TOOL = "Artifact";

export interface ArtifactPage {
  toolUseId: string;
  /** The local file it published, absolute. */
  file: string;
  /** Its page on claude.ai, when the call's result or its input says. */
  url?: string;
  /** The name the call gave it, when it gave one. */
  title?: string;
  description?: string;
  /** It updated a page published before. */
  update: boolean;
}

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A page's link on claude.ai, in either form the tool gives. */
const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/;

/** A file the tool publishes as a page, rather than one it uploads to a page's assets. */
const PAGE_FILE = /\.(?:html?|md)$/i;

/**
 * The page a call published, once it is done: a publish of an HTML or
 * Markdown file. Null for the tool's other calls (reading, listing,
 * uploading an asset), for one still going or failed, and for any other tool.
 */
export function artifactOf(tool: ToolCall | undefined, cwd: string): ArtifactPage | null {
  if (!tool || tool.name !== ARTIFACT_TOOL || tool.status !== "done") return null;
  if (tool.result?.isError) return null;
  const input = rec(tool.input);
  if (!input) return null;
  const action = str(input.action);
  if (action !== undefined && action !== "publish") return null;
  if (input.asset === true) return null;
  const path = str(input.file_path);
  if (!path || !PAGE_FILE.test(path)) return null;
  const file = resolveFilePath(path, cwd);
  if (!file) return null;
  const given = str(input.url);
  const url = tool.result?.text.match(ARTIFACT_URL)?.[0] ?? given?.match(ARTIFACT_URL)?.[0];
  return {
    toolUseId: tool.id,
    file,
    ...(url ? { url } : {}),
    ...(str(input.title) ? { title: str(input.title) } : {}),
    ...(str(input.description) ? { description: str(input.description) } : {}),
    update: given !== undefined,
  };
}

/** The pages a session published, newest last; a page published again is listed once, as it is now. */
export function artifactsOf(tools: Record<string, ToolCall>, cwd: string): ArtifactPage[] {
  const pages = new Map<string, ArtifactPage>();
  for (const tool of Object.values(tools)) {
    const page = artifactOf(tool, cwd);
    if (!page) continue;
    const key = page.url ?? page.file;
    pages.delete(key);
    pages.set(key, page);
  }
  return [...pages.values()];
}

/** Whether the page draws from HTML, which a thumbnail can show. */
export function isHtmlPage(page: ArtifactPage): boolean {
  return /\.html?$/i.test(page.file);
}

/** A page's name: the one the call gave, its document's title, or its file's. */
export function artifactName(page: ArtifactPage, documentTitle?: string | null): string {
  return page.title ?? documentTitle ?? baseName(page.file).replace(/\.(?:html?|md)$/i, "");
}

/** The text of an HTML document's `<title>`, its entities undone; null for none. */
export function titleOfHtml(head: string): string | null {
  const raw = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (raw === undefined) return null;
  const text = raw
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}
