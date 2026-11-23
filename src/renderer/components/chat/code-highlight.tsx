import { common, createLowlight } from "lowlight";
import { type ReactNode, useMemo } from "react";

const lowlight = createLowlight(common);

const MAX_HIGHLIGHT_CHARS = 50_000;

const NAMED_FILES: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
};

export function languageOf(path: string): string | undefined {
  const name = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  if (NAMED_FILES[name]) return NAMED_FILES[name];
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const ext = name.slice(dot + 1);
  return lowlight.registered(ext) ? ext : undefined;
}

export function Highlighted({ code, language }: { code: string; language?: string }) {
  const nodes = useMemo(() => highlightCode(code, language), [code, language]);
  return <>{nodes}</>;
}

interface Node {
  type: string;
  value?: string;
  properties?: { className?: unknown };
  children?: Node[];
}

export function highlightCode(code: string, language: string | undefined): ReactNode {
  if (!language || !code || code.length > MAX_HIGHLIGHT_CHARS) return code;
  if (!lowlight.registered(language)) return code;
  try {
    const root = lowlight.highlight(language, code) as unknown as Node;
    return (root.children ?? []).map(render);
  } catch {
    return code;
  }
}

function render(node: Node, index: number): ReactNode {
  if (node.type === "text") return node.value ?? "";
  if (node.type !== "element") return null;
  const names = node.properties?.className;
  const className = Array.isArray(names) ? names.join(" ") : undefined;
  return (
    <span key={index} className={className}>
      {(node.children ?? []).map(render)}
    </span>
  );
}
