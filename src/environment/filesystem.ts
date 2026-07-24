import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  win32,
} from "node:path";

import type { ObservedPreimage } from "../planning/actions.js";

const WINDOWS_EXECUTABLE_EXTENSIONS = [".exe", ".cmd", ".bat", ".com"];

export function sha256Bytes(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function observeRegularFile(path: string): ObservedPreimage {
  if (!existsSync(path)) return { kind: "missing" };
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`managed target must be a regular non-symlink file: ${path}`);
  }
  return {
    kind: "file",
    sha256: sha256File(path),
    size: stat.size,
  };
}

export function resolveStateRoot(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv,
): string {
  const configured = explicit
    ?? env.OH_MY_HARNESS_HOME
    ?? join(homedir(), ".oh-my-harness");
  if (!isAbsolute(configured) && !win32.isAbsolute(configured)) {
    throw new Error("managed state root must be absolute");
  }
  return resolve(configured);
}

function within(parent: string, child: string): boolean {
  const candidate = relative(parent, child);
  return candidate === ""
    || (candidate !== ".."
      && !candidate.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      && !isAbsolute(candidate));
}

function executableCandidates(command: string, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [command];
  if (WINDOWS_EXECUTABLE_EXTENSIONS.some((extension) =>
    command.toLowerCase().endsWith(extension)
  )) {
    return [command];
  }
  return [command, ...WINDOWS_EXECUTABLE_EXTENSIONS.map((extension) =>
    `${command}${extension}`)];
}

export function findTrustedExecutable(
  command: string,
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
  } = {},
): string | null {
  if (
    !command
    || command.includes("/")
    || command.includes("\\")
    || command.includes("\0")
  ) {
    throw new Error(`trusted executable lookup requires a bare command: ${command}`);
  }
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const workspace = resolve(options.cwd ?? process.cwd());
  const entries = (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean);
  for (const entry of entries) {
    if (!isAbsolute(entry) && !win32.isAbsolute(entry)) continue;
    let directory: string;
    try {
      directory = realpathSync(entry);
    } catch {
      continue;
    }
    if (within(workspace, directory)) continue;
    for (const candidate of executableCandidates(command, platform)) {
      const path = join(directory, candidate);
      try {
        const resolvedPath = realpathSync(path);
        if (within(workspace, resolvedPath)) continue;
        const stat = lstatSync(resolvedPath);
        if (!stat.isFile()) continue;
        if (
          platform !== "win32"
          && (stat.mode & (constants.S_IXUSR | constants.S_IXGRP | constants.S_IXOTH))
            === 0
        ) {
          continue;
        }
        return resolvedPath;
      } catch {
        continue;
      }
    }
  }
  return null;
}

export function atomicWriteFile(
  path: string,
  content: string,
  mode = 0o600,
): void {
  if (!isAbsolute(path) && !win32.isAbsolute(path)) {
    throw new Error("atomic write target must be absolute");
  }
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = lstatSync(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error(`atomic write parent must be a real directory: ${parent}`);
  }
  if (existsSync(path)) {
    const targetStat = lstatSync(path);
    if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
      throw new Error(`atomic write target must be a regular file: ${path}`);
    }
  }
  const temporary = join(
    parent,
    `.${basename(path)}.${process.pid}.${Date.now()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", mode);
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
