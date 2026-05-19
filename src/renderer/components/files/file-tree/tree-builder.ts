/**
 * Pure path-to-tree conversion utilities for the file-tree components.
 *
 * No I/O or side-effects. All functions are deterministic given the same
 * input.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PathTreeNode {
  name: string;
  relPath: string;
  kind: "dir" | "file";
  depth: number;
  /** Display label for the node. Currently always equals `name`. */
  displayName: string;
  children?: PathTreeNode[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Normalise a single path string: strip leading/trailing slashes. */
function normalisePath(p: string): string {
  return p.replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * Sort children in-place: directories first, then files; ties broken by
 * case-insensitive name ascending.
 */
function sortChildren(nodes: PathTreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
}

// ---------------------------------------------------------------------------
// buildPathTree
// ---------------------------------------------------------------------------

/**
 * Build a tree from a flat list of relative file paths.
 *
 * Returns a synthetic root node (depth=0, name="", kind="dir", relPath="")
 * whose `children` array contains the top-level entries.
 *
 * Rules:
 * - Leading/trailing "/" are stripped from each path.
 * - Empty strings are ignored.
 * - Duplicate paths are deduplicated.
 * - Children are sorted: directories first, then files; same-kind entries
 *   ordered case-insensitively by name.
 */
export function buildPathTree(paths: readonly string[]): PathTreeNode {
  const root: PathTreeNode = {
    name: "",
    relPath: "",
    kind: "dir",
    depth: 0,
    displayName: "",
    children: [],
  };

  // Deduplicate and normalise.
  const seen = new Set<string>();
  const normalised: string[] = [];
  for (const p of paths) {
    const n = normalisePath(p);
    if (n === "" || seen.has(n)) continue;
    seen.add(n);
    normalised.push(n);
  }

  // Insert each path into the tree.
  for (const relPath of normalised) {
    const segments = relPath.split("/");
    let current = root;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const isLast = i === segments.length - 1;
      const parentRelPath = current.relPath;
      const nodeRelPath = parentRelPath === "" ? seg : `${parentRelPath}/${seg}`;
      const depth = i + 1;

      // Find existing child with this relPath.
      let child = current.children!.find((c) => c.relPath === nodeRelPath);

      if (!child) {
        child = {
          name: seg,
          relPath: nodeRelPath,
          kind: isLast ? "file" : "dir",
          depth,
          displayName: seg,
          children: isLast ? undefined : [],
        };
        current.children!.push(child);
      } else if (!isLast && child.kind === "file") {
        // A segment that was previously a file is now also a directory prefix.
        // Promote it to dir.
        child.kind = "dir";
        child.children = child.children ?? [];
      }

      if (!isLast) {
        current = child;
      }
    }
  }

  // Sort every directory's children recursively.
  function sortRecursive(node: PathTreeNode): void {
    if (!node.children) return;
    sortChildren(node.children);
    for (const child of node.children) sortRecursive(child);
  }
  sortRecursive(root);

  return root;
}

// ---------------------------------------------------------------------------
// collectDescendantLeafPaths
// ---------------------------------------------------------------------------

/**
 * Collect the relPaths of all leaf (file) descendants of a node.
 *
 * - If the node is a file, returns `[node.relPath]`.
 * - If the node is a dir, recurses through all children and flattens results.
 */
export function collectDescendantLeafPaths(node: PathTreeNode): string[] {
  if (node.kind === "file") return [node.relPath];
  return node.children?.flatMap(collectDescendantLeafPaths) ?? [];
}
