import {
  closeSync,
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
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";

import type {
  ApplyJournal,
  ManagedStateReceipt,
  StatePort,
} from "../ports/state.js";
import { withFileLock } from "./lock.js";

function assertSafeStateRoot(path: string): string {
  if (!isAbsolute(path)) throw new Error("state root must be absolute");
  const resolved = resolve(path);
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
    throw new Error(`unsafe state root symbolic link: ${resolved}`);
  }
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`state root must be a real directory: ${resolved}`);
  }
  return realpathSync(resolved);
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`unsafe managed state file: ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function atomicWriteJson(path: string, value: unknown): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (lstatSync(parent).isSymbolicLink()) {
    throw new Error(`unsafe managed state parent: ${parent}`);
  }
  if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile())) {
    throw new Error(`unsafe managed state target: ${path}`);
  }
  const temporary = join(
    parent,
    `.${basename(path)}.${process.pid}.${Date.now()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

export class FileStateStore implements StatePort {
  readonly root: string;
  readonly lockTimeoutMs: number;

  constructor(root: string, options: { readonly lockTimeoutMs?: number } = {}) {
    this.root = assertSafeStateRoot(root);
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
  }

  async withApplyLock<T>(operation: () => Promise<T>): Promise<T> {
    return withFileLock(
      join(this.root, "locks", "apply.lock"),
      operation,
      { timeoutMs: this.lockTimeoutMs },
    );
  }

  async readJournal(): Promise<ApplyJournal | null> {
    return readJson<ApplyJournal>(join(this.root, "journal", "apply.json"));
  }

  async writeJournal(journal: ApplyJournal): Promise<void> {
    atomicWriteJson(join(this.root, "journal", "apply.json"), journal);
  }

  async publishReceipt(receipt: ManagedStateReceipt): Promise<void> {
    atomicWriteJson(join(this.root, "receipts", "environment.json"), receipt);
  }
}
