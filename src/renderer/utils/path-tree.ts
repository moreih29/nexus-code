export interface PathTreeNode {
  name: string;
  relPath: string;
  kind: "dir" | "file";
  depth: number;
  displayName: string;
  children?: PathTreeNode[];
}

function normalisePath(p: string): string {
  return p.replace(/^\/+/, "").replace(/\/+$/, "");
}

function sortChildren(nodes: PathTreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
}

export function buildPathTree(paths: readonly string[]): PathTreeNode {
  const root: PathTreeNode = {
    name: "",
    relPath: "",
    kind: "dir",
    depth: 0,
    displayName: "",
    children: [],
  };

  const seen = new Set<string>();
  const normalised: string[] = [];
  for (const p of paths) {
    const n = normalisePath(p);
    if (n === "" || seen.has(n)) continue;
    seen.add(n);
    normalised.push(n);
  }

  for (const relPath of normalised) {
    const segments = relPath.split("/");
    let current = root;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const isLast = i === segments.length - 1;
      const parentRelPath = current.relPath;
      const nodeRelPath = parentRelPath === "" ? seg : `${parentRelPath}/${seg}`;
      const depth = i + 1;

      current.children ??= [];
      let child = current.children.find((c) => c.relPath === nodeRelPath);

      if (!child) {
        child = {
          name: seg,
          relPath: nodeRelPath,
          kind: isLast ? "file" : "dir",
          depth,
          displayName: seg,
          children: isLast ? undefined : [],
        };
        current.children.push(child);
      } else if (!isLast && child.kind === "file") {
        child.kind = "dir";
        child.children = child.children ?? [];
      }

      if (!isLast) {
        current = child;
      }
    }
  }

  function sortRecursive(node: PathTreeNode): void {
    if (!node.children) return;
    sortChildren(node.children);
    for (const child of node.children) sortRecursive(child);
  }
  sortRecursive(root);

  return root;
}

export function collectDescendantLeafPaths(node: PathTreeNode): string[] {
  if (node.kind === "file") return [node.relPath];
  return node.children?.flatMap(collectDescendantLeafPaths) ?? [];
}
