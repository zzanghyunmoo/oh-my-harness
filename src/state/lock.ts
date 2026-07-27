import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const LOCK_INITIALIZATION_GRACE_MS = 1_000;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export interface FileLockOptions {
  readonly pollMs?: number;
  readonly timeoutMs?: number;
}

function crashStaleLock(path: string): boolean {
  let stat: ReturnType<typeof lstatSync>;
  let owner: string;
  try {
    stat = lstatSync(path);
    owner = readFileSync(path, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
    if (code === "ENOENT") return false;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 64) {
    throw new Error(`state lock is not a bounded regular file: ${path}`);
  }
  if (stat.size === 0) {
    return Date.now() - stat.mtimeMs >= LOCK_INITIALIZATION_GRACE_MS;
  }
  if (!/^[1-9][0-9]*\n$/u.test(owner)) {
    throw new Error(`state lock has invalid owner metadata: ${path}`);
  }
  const pid = Number.parseInt(owner, 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`state lock has invalid owner pid: ${path}`);
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    const code = error instanceof Error && "code" in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
    if (["ESRCH", "EINVAL", "ERR_OUT_OF_RANGE"].includes(code ?? "")) {
      return true;
    }
    if (code === "EPERM") return false;
    throw error;
  }
}

export async function withFileLock<T>(
  path: string,
  operation: () => Promise<T>,
  {
    pollMs = 20,
    timeoutMs = 5_000,
  }: FileLockOptions = {},
): Promise<T> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const startedAt = Date.now();
  let descriptor: number | undefined;
  while (descriptor === undefined) {
    try {
      const acquired = openSync(path, "wx", 0o600);
      try {
        writeFileSync(acquired, `${process.pid}\n`, "utf8");
        descriptor = acquired;
      } catch (error) {
        closeSync(acquired);
        rmSync(path, { force: true });
        throw error;
      }
    } catch (error) {
      const code = error instanceof Error && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
      if (code !== "EEXIST") throw error;
      if (crashStaleLock(path)) {
        try {
          rmSync(path, { force: false });
        } catch (removeError) {
          const removeCode = removeError instanceof Error && "code" in removeError
            ? (removeError as NodeJS.ErrnoException).code
            : undefined;
          if (removeCode !== "ENOENT") throw removeError;
        }
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`timed out waiting for state lock: ${path}`);
      }
      await wait(pollMs);
    }
  }
  try {
    return await operation();
  } finally {
    closeSync(descriptor);
    rmSync(path, { force: true });
  }
}
