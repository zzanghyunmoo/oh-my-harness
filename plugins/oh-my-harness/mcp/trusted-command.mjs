import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, relative, resolve, sep } from "node:path";

const MAX_SHIM_BYTES = 16 * 1024;

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

function trustedRegularFile(path, { executable, platform, workspace }) {
  try {
    const canonical = realpathSync(path);
    const stat = statSync(canonical);
    if (!stat.isFile()) return undefined;
    if (executable && platform !== "win32" && (stat.mode & 0o111) === 0) return undefined;
    return isWithin(workspace, canonical) ? undefined : canonical;
  } catch {
    return undefined;
  }
}

function hasNodeShebang(path) {
  let descriptor;
  try {
    descriptor = openSync(path, "r");
    const buffer = Buffer.alloc(256);
    const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytes).toString("utf8").split(/\r?\n/, 1)[0];
    return /^#!\s*(?:\/usr\/bin\/env(?:\s+-S)?\s+)?(?:[a-z]:[\\/][^\s]*[\\/]|\/[^\s]*\/)?node(?:\.exe)?\s*$/i.test(firstLine);
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readBoundedShim(path) {
  let descriptor;
  try {
    const stat = statSync(path);
    if (stat.size > MAX_SHIM_BYTES) return undefined;
    descriptor = openSync(path, "r");
    const buffer = Buffer.alloc(stat.size);
    const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytes).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function npmCmdTarget(path, workspace) {
  if (basename(path).toLowerCase() !== "npm.cmd") return undefined;
  const body = readBoundedShim(path);
  if (!body || !/^@ECHO off\r?$/im.test(body) || !/node_modules\\npm\\bin\\npm-cli\.js/i.test(body)) return undefined;
  return trustedRegularFile(resolve(dirname(path), "node_modules", "npm", "bin", "npm-cli.js"), {
    executable: false,
    platform: "win32",
    workspace,
  });
}

function cmdShimNodeTarget(path, workspace) {
  const body = readBoundedShim(path);
  if (!body || !/^@ECHO off\r?$/im.test(body) || !/^SET dp0=%~dp0\r?$/im.test(body)) return undefined;
  const matches = [...body.matchAll(/"%dp0%\\([^"%\r\n]+)"(?=\s+%\*(?:\r?\n|$))/gi)];
  const relativeTarget = matches.at(-1)?.[1];
  const segments = relativeTarget?.split("\\");
  if (!segments?.length || segments.some((segment) => !segment || segment === "." || segment === ".." || /[:/]/.test(segment))) return undefined;
  return trustedRegularFile(resolve(dirname(path), ...segments), {
    executable: false,
    platform: "win32",
    workspace,
  });
}

function resolveWindowsCmdShim(path, workspace) {
  const target = npmCmdTarget(path, workspace) ?? cmdShimNodeTarget(path, workspace);
  return target && hasNodeShebang(target) ? target : undefined;
}

export function resolveTrustedFile(path, { executable = false, platform = process.platform, workspace = process.cwd() } = {}) {
  if (typeof path !== "string" || !path || !isAbsolute(path)) return undefined;
  return trustedRegularFile(resolve(path), {
    executable,
    platform,
    workspace: canonicalWorkspace(workspace),
  });
}

export function resolveTrustedInvocation(commands, { env = process.env, platform = process.platform, workspace = process.cwd() } = {}) {
  if (!Array.isArray(commands) || commands.length === 0) fail("commands must be a non-empty array");
  if (commands.some((command) => typeof command !== "string" || !command || basename(command) !== command || command.includes("/") || command.includes("\\"))) {
    fail("commands must contain command names without paths");
  }
  const canonicalRoot = canonicalWorkspace(workspace);
  for (const rawDirectory of String(env.PATH ?? "").split(delimiter)) {
    if (!rawDirectory || !isAbsolute(rawDirectory)) continue;
    for (const command of commands) {
      const suffixes = platform === "win32" && !/\.(?:exe|cmd|bat)$/i.test(command)
        ? [".exe", "", ".cmd", ".bat"]
        : [""];
      for (const suffix of suffixes) {
        const candidate = trustedRegularFile(resolve(rawDirectory, `${command}${suffix}`), {
          executable: true,
          platform,
          workspace: canonicalRoot,
        });
        if (!candidate) continue;
        if (platform !== "win32" || /\.exe$/i.test(candidate)) {
          return Object.freeze({ argsPrefix: Object.freeze([]), command: candidate, executablePath: candidate });
        }
        if (!/\.(?:cmd|bat)$/i.test(candidate) && hasNodeShebang(candidate)) {
          return Object.freeze({ argsPrefix: Object.freeze([candidate]), command: process.execPath, executablePath: candidate });
        }
        if (/\.cmd$/i.test(candidate)) {
          const target = resolveWindowsCmdShim(candidate, canonicalRoot);
          if (target) return Object.freeze({ argsPrefix: Object.freeze([target]), command: process.execPath, executablePath: candidate });
        }
      }
    }
  }
  return undefined;
}

export function resolveTrustedCommand(commands, options = {}) {
  return resolveTrustedInvocation(commands, options)?.executablePath;
}
