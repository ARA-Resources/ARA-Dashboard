import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Resolve monorepo root (directory containing `src/app`).
 * Works when cwd is repo root or backend/.
 */
export function resolveRepoRoot(): string {
  const cwd = process.cwd();
  const rootMarker = path.join("src", "app");
  if (existsSync(path.join(cwd, rootMarker))) {
    return cwd;
  }
  const parent = path.resolve(cwd, "..");
  if (existsSync(path.join(parent, rootMarker))) {
    return parent;
  }
  return cwd;
}

export function repoDataDir(): string {
  return path.join(resolveRepoRoot(), ".data");
}
