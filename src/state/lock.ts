import {
  closeSync,
  mkdirSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export interface FileLockOptions {
  readonly pollMs?: number;
  readonly timeoutMs?: number;
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
      descriptor = openSync(path, "wx", 0o600);
      writeFileSync(descriptor, `${process.pid}\n`, "utf8");
    } catch (error) {
      const code = error instanceof Error && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
      if (code !== "EEXIST") throw error;
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
