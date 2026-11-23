import { baseName, resolveFilePath } from "./links";
import type { ToolCall } from "./model";

export const ARTIFACT_TOOL = "Artifact";

export interface ArtifactPage {
  toolUseId: string;
  file: string;
  url?: string;
  title?: string;
  description?: string;
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

const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/;

const PAGE_FILE = /\.(?:html?|md)$/i;

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

export function isHtmlPage(page: ArtifactPage): boolean {
  return /\.html?$/i.test(page.file);
}

export function artifactName(page: ArtifactPage, documentTitle?: string | null): string {
  return page.title ?? documentTitle ?? baseName(page.file).replace(/\.(?:html?|md)$/i, "");
}

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
