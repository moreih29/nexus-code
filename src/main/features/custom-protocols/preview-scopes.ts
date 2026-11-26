import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { promisify } from "node:util";
import { cleanAbsolutePath } from "../fs/outside-grants";

export interface PreviewScope {
  readonly workspaceId: string;
  readonly dir: string;
}

interface HeldScope extends PreviewScope {
  readonly owner: number;
}

export const MAX_SCOPES_PER_OWNER = 256;

export const realpathNative = promisify(fs.realpath.native);

const SHARED_PARENTS = /^\/(users|home|volumes|mnt|media|private|run\/media\/[^/]+)\/[^/]+$/i;
const WINDOWS_PROFILE = /^[a-z]:\/users\/[^/]+$/i;

function comparable(dir: string): string {
  return dir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() || "/";
}

export function isBroadDir(dir: string, home: string): boolean {
  const at = comparable(dir);
  const rest = at.replace(/^[a-z]:/, "").replace(/^\//, "");
  if (rest === "" || !rest.includes("/")) return true;
  if (SHARED_PARENTS.test(at) || WINDOWS_PROFILE.test(at)) return true;
  const own = comparable(home);
  return own !== "/" && (own === at || own.startsWith(`${at}/`));
}

export class PreviewScopes {
  private readonly scopes = new Map<string, HeldScope>();
  private readonly byKey = new Map<string, string>();

  constructor(
    private readonly home: string,
    private readonly newId: () => string = () => randomBytes(16).toString("hex"),
  ) {}

  open(owner: number, workspaceId: string, dir: string): string | null {
    const clean = cleanAbsolutePath(dir);
    if (!clean || isBroadDir(clean, this.home)) return null;
    const key = `${owner}\0${workspaceId}\0${clean}`;
    const held = this.byKey.get(key);
    if (held) {
      const scope = this.scopes.get(held);
      if (scope) {
        this.scopes.delete(held);
        this.scopes.set(held, scope);
        return held;
      }
    }
    const mine = [...this.scopes].filter(([, scope]) => scope.owner === owner);
    for (const [id] of mine.slice(0, Math.max(0, mine.length - MAX_SCOPES_PER_OWNER + 1))) {
      this.drop(id);
    }
    const id = this.newId();
    this.scopes.set(id, { owner, workspaceId, dir: clean });
    this.byKey.set(key, id);
    return id;
  }

  get(id: string): PreviewScope | undefined {
    const scope = this.scopes.get(id);
    return scope && { workspaceId: scope.workspaceId, dir: scope.dir };
  }

  heldBy(owner: number, id: string): boolean {
    return this.scopes.get(id)?.owner === owner;
  }

  releaseOwner(owner: number): void {
    for (const [id, scope] of this.scopes) if (scope.owner === owner) this.drop(id);
  }

  size(owner?: number): number {
    if (owner === undefined) return this.scopes.size;
    return [...this.scopes.values()].filter((scope) => scope.owner === owner).length;
  }

  private drop(id: string): void {
    const scope = this.scopes.get(id);
    if (!scope) return;
    this.scopes.delete(id);
    this.byKey.delete(`${scope.owner}\0${scope.workspaceId}\0${scope.dir}`);
  }
}
