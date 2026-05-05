import { resolve as resolvePath } from "node:path";

export function resolveBundledBinary(binary: string): string {
  return resolvePath(__dirname, `../../node_modules/.bin/${binary}`);
}
