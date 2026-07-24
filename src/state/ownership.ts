import {
  lstatSync,
} from "node:fs";

import { sha256File as hashFile } from "../environment/filesystem.js";
import type { ObservedPreimage } from "../planning/actions.js";

export function sha256File(path: string): string {
  return hashFile(path);
}

export function observePath(path: string): ObservedPreimage {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`managed target is not a regular file: ${path}`);
    }
    return {
      kind: "file",
      sha256: sha256File(path),
      size: stat.size,
    };
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { kind: "missing" };
    }
    throw error;
  }
}

export function samePreimage(
  left: ObservedPreimage,
  right: ObservedPreimage,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "missing" || right.kind === "missing") return true;
  if (left.kind === "directory" || right.kind === "directory") {
    return left.sha256 === right.sha256;
  }
  return left.sha256 === right.sha256 && left.size === right.size;
}
