import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const renderer = fileURLToPath(new URL("../../../../../src/renderer/", import.meta.url));
const workbench = resolve(renderer, "components/peer-workspace");
const forbidden = [
  "services/fs-mutations",
  "state/operations/files",
  "state/stores/git/operations",
  "services/editor/save",
  "services/editor/tabs",
  "services/editor/git/staging",
  "components/files/git/commit",
];
const peerReads = new Set([
  "peerFilesList",
  "peerFilesFind",
  "peerFilesSearch",
  "peerFilesRead",
  "peerFilesReadBytes",
  "peerGitDiff",
]);

function modulePath(file: string, path: string): string | undefined {
  const resolved = path.startsWith("@/")
    ? resolve(renderer, path.slice(2))
    : path.startsWith(".")
      ? resolve(dirname(file), path)
      : undefined;
  return (
    resolved &&
    relative(renderer, resolved)
      .replaceAll("\\", "/")
      .replace(/\.[jt]sx?$/, "")
  );
}

function literal(node: ts.Node | undefined): string | undefined {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}

function isIpcFunction(name: string): boolean {
  return name.startsWith("ipcCall") || name === "ipcStream";
}

function peerReadViolations(file: string, source: string): string[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest);
  const violations: string[] = [];
  const ipcAliases = new Set<string>();
  function checkImport(specifier: ts.Node | undefined) {
    const path = literal(specifier);
    if (path === undefined) return;
    const normalized = modulePath(file, path);
    if (forbidden.some((entry) => normalized === entry || normalized?.startsWith(`${entry}/`))) {
      violations.push(`imports ${path}`);
    }
  }
  visit(ast, (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      checkImport(node.moduleSpecifier);
    if (!ts.isImportDeclaration(node)) return;
    const bindings = node.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) return;
    for (const { name, propertyName } of bindings.elements) {
      if (propertyName && isIpcFunction(propertyName.text)) ipcAliases.add(name.text);
    }
  });
  visit(ast, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    if (
      callee.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(callee) && callee.text === "require")
    ) {
      checkImport(node.arguments[0]);
    }
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isElementAccessExpression(callee)
          ? literal(callee.argumentExpression)
          : undefined;
    if (!name || (!isIpcFunction(name) && !ipcAliases.has(name))) return;
    const [channel, method] = node.arguments;
    if (literal(channel) !== "remote" || !peerReads.has(literal(method) ?? "")) {
      violations.push(
        `calls ${callee.getText(ast)}(${channel?.getText(ast)}, ${method?.getText(ast)})`,
      );
    }
  });
  return violations;
}

test("peer workspace components can import only allowed modules and call only peer read IPCs", () => {
  const files = [...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: workbench })];
  expect(files.length).toBeGreaterThan(0);
  for (const path of files) {
    const file = resolve(workbench, path);
    expect(peerReadViolations(file, readFileSync(file, "utf8")), path).toEqual([]);
  }
});

test("the peer read guard detects local imports and direct IPC writes", () => {
  const file = resolve(workbench, "example.tsx");
  const violations = peerReadViolations(
    file,
    `import { commit } from "../files/git/commit";
     import("@/services/editor/tabs");
     import { ipcCallResult as call } from "../../ipc/client";
     call("remote", "peerTerminalInput", {});
     ipc.ipcCallResult("remote", "peerChatUploadBegin", {});
     ipcCallResult("fs", "write", {});
     ipcCallResult("remote", method, {});
     call("remote", "peerFilesSearch", {});`,
  );
  expect(violations).toEqual([
    "imports ../files/git/commit",
    "imports @/services/editor/tabs",
    'calls call("remote", "peerTerminalInput")',
    'calls ipc.ipcCallResult("remote", "peerChatUploadBegin")',
    'calls ipcCallResult("fs", "write")',
    'calls ipcCallResult("remote", method)',
  ]);
});
