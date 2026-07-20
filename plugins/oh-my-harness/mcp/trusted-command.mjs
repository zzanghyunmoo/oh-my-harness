import { realpathSync, statSync } from "node:fs";
import { basename, delimiter, isAbsolute, relative, resolve, sep } from "node:path";

function fail(message) {
  throw new Error(message);
}

function canonicalWorkspace(workspace) {
  if (typeof workspace !== "string" || !workspace || !isAbsolute(workspace)) {
    fail("workspace must be an absolute path");
  }
  try {
    const path = realpathSync(resolve(workspace));
    if (!statSync(path).isDirectory()) fail("workspace must be a real directory");
    return path;
  } catch (error) {
    if (error instanceof Error && error.message === "workspace must be a real directory") throw error;
    fail("workspace must be an existing real directory");
  }
}

function isWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function trustedRegularFile(path, { executable, workspace }) {
  try {
    const canonical = realpathSync(path);
    const stat = statSync(canonical);
    if (!stat.isFile()) return undefined;
    if (executable && process.platform !== "win32" && (stat.mode & 0o111) === 0) return undefined;
    return isWithin(workspace, canonical) ? undefined : canonical;
  } catch {
    return undefined;
  }
}

export function resolveTrustedFile(path, { executable = false, workspace = process.cwd() } = {}) {
  if (typeof path !== "string" || !path || !isAbsolute(path)) return undefined;
  return trustedRegularFile(resolve(path), {
    executable,
    workspace: canonicalWorkspace(workspace),
  });
}

export function resolveTrustedCommand(commands, { env = process.env, workspace = process.cwd() } = {}) {
  if (!Array.isArray(commands) || commands.length === 0) fail("commands must be a non-empty array");
  if (commands.some((command) => typeof command !== "string" || !command || basename(command) !== command || command.includes("/") || command.includes("\\"))) {
    fail("commands must contain command names without paths");
  }
  const canonicalRoot = canonicalWorkspace(workspace);
  for (const rawDirectory of String(env.PATH ?? "").split(delimiter)) {
    if (!rawDirectory || !isAbsolute(rawDirectory)) continue;
    for (const command of commands) {
      const suffixes = process.platform === "win32" && !/\.(?:exe|cmd|bat)$/i.test(command)
        ? ["", ".exe", ".cmd", ".bat"]
        : [""];
      for (const suffix of suffixes) {
        const candidate = trustedRegularFile(resolve(rawDirectory, `${command}${suffix}`), {
          executable: true,
          workspace: canonicalRoot,
        });
        if (candidate) return candidate;
      }
    }
  }
  return undefined;
}
