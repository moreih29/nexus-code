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
  "peerGitLog",
  "peerGitShow",
  "peerGitStatus",
  "peerSystemStats",
]);
const agentView = "components/agent-view";
const remote = "services/remote";
const restricted = [agentView, remote];
const allowedImports: readonly [file: string, module: string, ...names: string[]][] = [
  ["panel.tsx", `${agentView}/remote-new-menu`, "RemoteNewMenu"],
  ["panel.tsx", `${agentView}/remote-session-actions`, "PeerSessionRef", "renamePeerSession"],
  ["panel.tsx", `${agentView}/remote-sessions`, "RemoteStateGlyph"],
  ["session-tab.tsx", `${agentView}/remote-pane`, "RemoteSessionPane"],
  ["session-tab.tsx", `${agentView}/remote-session-host`, "RemoteSessionHost"],
  ["sessions-panel.tsx", `${agentView}/remote-new-menu`, "RemoteNewMenu"],
  [
    "sessions-panel.tsx",
    `${agentView}/remote-session-actions`,
    "closePeerSession",
    "newPeerChat",
    "PeerSessionRef",
    "PeerWorkspaceRef",
    "renamePeerSession",
  ],
  ["sessions-panel.tsx", `${agentView}/remote-session-branch`, "RemoteSessionBranch"],
  [
    "sessions-panel.tsx",
    `${agentView}/remote-sessions`,
    "agentRunsOf",
    "FAILURE_SCHEMA",
    "listedByDefault",
    "OpenRemoteSessionRow",
    "SessionMenu",
    "statusGroups",
  ],
  ["sessions-panel.tsx", `${remote}/display-name`, "remoteDisplayName"],
  ["sessions-panel.tsx", `${remote}/room`, "PeerSessions", "peerServes", "peerSpeaks"],
  ["diff-model.ts", `${remote}/file-comparison`, "beforeOfWorkingText"],
  ["diff-model.ts", `${remote}/peer-git-status`, "isPeerGitConflict", "PeerGitFile", "PeerGitSide"],
  ["diff-model.ts", `${remote}/peer-workspace`, "PeerText", "readPeerWorkspaceText"],
  ["diff-model.ts", `${remote}/peer-git-paths`, "peerGitPaths"],
  ["git-path-label.ts", `${remote}/peer-git-paths`, "peerGitPaths"],
  ["git-tree.ts", `${remote}/peer-git-paths`, "peerGitPaths"],
  ["diff-tab.tsx", `${remote}/peer-git-status`, "PeerGitFile"],
  ["file-tree.tsx", `${remote}/room`, "refreshPeerSessions"],
  ["git-panel.tsx", `${remote}/peer-git-status`, "PeerGitFile", "PeerGitSide"],
  ["git-panel.tsx", `${remote}/peer-git-paths`, "peerGitPaths"],
  ["git-groups.ts", `${remote}/peer-git-status`, "isPeerGitConflict", "PeerGitFile", "PeerGitSide"],
  ["status-bar.tsx", `${remote}/peer-git-status`, "PeerGitStatus"],
  ["system-stats.tsx", `${remote}/room`, "peerServes"],
  ["git-tree.ts", `${remote}/peer-git-status`, "isPeerGitConflict", "PeerGitStatus"],
  ["panel.tsx", `${remote}/display-name`, "remoteTitle"],
  ["panel.tsx", `${remote}/room`, "PeerReach", "peerServes"],
  ["quick-open.tsx", `${remote}/peer-quick-open`, "subscribePeerQuickOpen"],
  ["quick-open.tsx", `${remote}/room`, "PeerReach"],
  ["room.ts", `${remote}/account`, "remoteAccountKey", "useRemoteAccount"],
  ["room.ts", `${remote}/peer-git-status`, "watchPeerGitStatus"],
  [
    "room.ts",
    `${remote}/room`,
    "observePeerSessions",
    "offlinePeers",
    "PeerReach",
    "refreshPeerSessions",
    "servingPeers",
    "usePeerSessions",
    "useRemoteRoom",
    "useShownRoom",
  ],
  ["search-model.ts", `${remote}/room`, "refreshPeerSessions"],
  ["session-placement.ts", `${remote}/room`, "peerSessionsReadSequence", "refreshPeerSessions"],
  ["files-panel.tsx", `${remote}/room`, "PeerSessions"],
  ["sidebar.tsx", `${remote}/room`, "PeerSessions"],
];

function within(path: string | undefined, directory: string): boolean {
  return path === directory || path?.startsWith(`${directory}/`) === true;
}

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
  const filename = relative(workbench, file).replaceAll("\\", "/");
  function checkImport(specifier: ts.Node | undefined, clause?: ts.ImportClause) {
    const path = literal(specifier);
    if (path === undefined) return;
    const normalized = modulePath(file, path);
    if (forbidden.some((entry) => within(normalized, entry))) {
      violations.push(`imports ${path}`);
      return;
    }
    if (!restricted.some((entry) => within(normalized, entry))) return;
    const allowed = allowedImports.find(
      ([from, module]) => from === filename && module === normalized,
    );
    const bindings = clause?.namedBindings;
    if (
      !allowed ||
      clause?.name ||
      !bindings ||
      !ts.isNamedImports(bindings) ||
      !bindings.elements.length ||
      bindings.elements.some(
        ({ name, propertyName }) => !allowed.slice(2).includes((propertyName ?? name).text),
      )
    ) {
      violations.push(`imports ${path}`);
    }
  }
  visit(ast, (node) => {
    if (ts.isImportDeclaration(node)) checkImport(node.moduleSpecifier, node.importClause);
    if (ts.isExportDeclaration(node)) checkImport(node.moduleSpecifier);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      checkImport(node.moduleReference.expression);
    }
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

test("peer workspace components use named session gateways and only call peer read IPC directly", () => {
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

test("only the designated peer workspace files can host the existing session controls", () => {
  const component = (name: string) => resolve(workbench, name);
  expect(
    peerReadViolations(
      component("session-tab.tsx"),
      'import { RemoteSessionPane } from "../agent-view/remote-pane"',
    ),
  ).toEqual([]);
  expect(
    peerReadViolations(
      component("panel.tsx"),
      'import { RemoteNewMenu } from "../agent-view/remote-new-menu"',
    ),
  ).toEqual([]);
  expect(
    peerReadViolations(
      component("session-tab.tsx"),
      `import { RemoteNewMenu } from "../agent-view/remote-new-menu";
       import { closePeerSession } from "../agent-view/remote-session-actions";
       import { PeerConsentCard } from "../agent-view/remote-consents";
       ipcCallResult("remote", "peerChatAnswer", {});
       ipcCallResult("remote", "peerTerminalOpen", {});`,
    ),
  ).toEqual([
    "imports ../agent-view/remote-new-menu",
    "imports ../agent-view/remote-session-actions",
    "imports ../agent-view/remote-consents",
    'calls ipcCallResult("remote", "peerChatAnswer")',
    'calls ipcCallResult("remote", "peerTerminalOpen")',
  ]);
});

test.each([
  [
    "session-tab.tsx",
    'import { usePeerComposer } from "../../services/remote/peer-composer"',
    "../../services/remote/peer-composer",
  ],
  [
    "panel.tsx",
    'import { AgentSidebar } from "../agent-view/agent-sidebar"',
    "../agent-view/agent-sidebar",
  ],
  [
    "sessions-panel.tsx",
    'import { OpenRemoteSessionRow, RemoteSessions as Sessions } from "../agent-view/remote-sessions"',
    "../agent-view/remote-sessions",
  ],
  [
    "session-tab.tsx",
    'import { runInPeerTerminal } from "../agent-view/remote-pane"',
    "../agent-view/remote-pane",
  ],
  [
    "sessions-panel.tsx",
    'import * as remote from "../agent-view/remote-sessions"',
    "../agent-view/remote-sessions",
  ],
  [
    "sessions-panel.tsx",
    'export * from "../agent-view/remote-sessions"',
    "../agent-view/remote-sessions",
  ],
  [
    "session-tab.tsx",
    'import { watchPeerTerminalTyping } from "@/services/remote/peer-terminal"',
    "@/services/remote/peer-terminal",
  ],
])("%s cannot bypass the named remote gateway with %s", (file, source, path) => {
  expect(peerReadViolations(resolve(workbench, file), source)).toEqual([`imports ${path}`]);
});
