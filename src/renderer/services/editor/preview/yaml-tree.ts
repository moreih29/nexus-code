import {
  type Document,
  isAlias,
  isMap,
  isPair,
  isScalar,
  isSeq,
  type Node,
  parseAllDocuments,
} from "yaml";
import { type JsonEntry, JsonSyntaxError, type JsonValue } from "./json-tree";

const MAX_DEPTH = 500;

export function parseYaml(text: string): JsonValue {
  const documents = parseAllDocuments(text, { prettyErrors: false, uniqueKeys: false });
  const docs: Document.Parsed[] = Array.isArray(documents) ? documents : [];
  for (const doc of docs) {
    const error = doc.errors[0];
    if (error) {
      const { line, column } = lineAndColumn(text, error.pos[0]);
      throw new JsonSyntaxError(error.message, line, column);
    }
  }
  if (docs.length === 0) return { kind: "null" };
  if (docs.length === 1) return documentValue(docs[0] as Document.Parsed);
  return { kind: "array", items: docs.map(documentValue) };
}

function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) {
    line++;
    lineStart = i + 1;
  }
  return { line, column: offset - lineStart + 1 };
}

function documentValue(doc: Document.Parsed): JsonValue {
  const open = new Set<Node>();

  const convert = (node: unknown, depth: number): JsonValue => {
    if (node === null || node === undefined) return { kind: "null" };
    if (isAlias(node)) {
      const target = node.resolve(doc);
      if (!target || open.has(target)) return { kind: "string", value: `*${node.source}` };
      return convert(target, depth);
    }
    if (depth > MAX_DEPTH) return { kind: "string", value: String(node) };
    if (isMap(node)) {
      open.add(node);
      const entries: JsonEntry[] = [];
      for (const pair of node.items) {
        if (!isPair(pair)) continue;
        entries.push({ key: keyText(pair.key), value: convert(pair.value, depth + 1) });
      }
      open.delete(node);
      return { kind: "object", entries };
    }
    if (isSeq(node)) {
      open.add(node);
      const items = node.items.map((item) => convert(item, depth + 1));
      open.delete(node);
      return { kind: "array", items };
    }
    if (isScalar(node)) return scalar(node.value, node.source);
    return { kind: "string", value: String(node) };
  };

  return convert(doc.contents, 0);
}

function scalar(value: unknown, source: string | undefined): JsonValue {
  if (value === null || value === undefined) return { kind: "null" };
  if (typeof value === "boolean") return { kind: "boolean", value };
  if (typeof value === "number" || typeof value === "bigint") {
    return { kind: "number", text: source ?? String(value) };
  }
  if (typeof value === "string") return { kind: "string", value };
  if (value instanceof Date) return { kind: "string", value: source ?? value.toISOString() };
  return { kind: "string", value: source ?? String(value) };
}

function keyText(key: unknown): string {
  if (key === null || key === undefined) return "";
  if (isScalar(key)) return key.value === null ? "" : String(key.source ?? key.value);
  if (isAlias(key)) return `*${key.source}`;
  return String(key);
}
