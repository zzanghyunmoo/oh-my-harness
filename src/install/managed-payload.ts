import { createHash, randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import type { ObservedPreimage } from "../planning/actions.js";

const MAX_ENTRIES = 4_096;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

const PAYLOAD_PATHS = [
  ".agents/plugins/marketplace.json",
  ".claude-plugin/marketplace.json",
  ".opencode/package.json",
  ".opencode/plugins/oh-my-harness.js",
  "dist",
  "package.json",
  "plugins/oh-my-harness",
] as const;

interface PayloadSource {
  readonly destination: string;
  readonly source: string;
}

interface HashedFile {
  readonly path: string;
  readonly digest: string;
}

export interface ManagedRuntimePayload {
  readonly activeRoot: string;
  readonly digest: string;
  readonly sourceRoot: string;
  readonly storeRoot: string;
}

function portablePath(path: string): string {
  return path.split(sep).join("/");
}

function collectFiles(
  root: string,
  source: string,
  destinationPrefix: string,
  budget: { entries: number; bytes: number },
): HashedFile[] {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) {
    throw new Error(`managed payload source contains a symbolic link: ${source}`);
  }
  budget.entries += 1;
  if (budget.entries > MAX_ENTRIES) {
    throw new Error("managed runtime payload has too many entries");
  }
  if (stat.isDirectory()) {
    return readdirSync(source, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
      .flatMap((entry) =>
        collectFiles(
          root,
          join(source, entry.name),
          join(destinationPrefix, entry.name),
          budget,
        )
      );
  }
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
    throw new Error(`managed payload source is not a bounded regular file: ${source}`);
  }
  budget.bytes += stat.size;
  if (budget.bytes > MAX_TOTAL_BYTES) {
    throw new Error("managed runtime payload exceeds the byte limit");
  }
  return [{
    digest: createHash("sha256").update(readFileSync(source)).digest("hex"),
    path: portablePath(relative(root, join(root, destinationPrefix))),
  }];
}

function digestFiles(files: readonly HashedFile[]): string {
  const digest = createHash("sha256");
  for (const file of [...files].sort((left, right) =>
    left.path.localeCompare(right.path)
  )) {
    digest.update(`${file.path}\0${file.digest}\0`, "utf8");
  }
  return digest.digest("hex");
}

function dependencyRoot(
  repositoryRoot: string,
  packageName: string,
  expectedVersion: string,
): string {
  const require = createRequire(join(repositoryRoot, "package.json"));
  let current = dirname(require.resolve(packageName));
  while (dirname(current) !== current) {
    const manifest = join(current, "package.json");
    if (existsSync(manifest)) {
      const value = JSON.parse(readFileSync(manifest, "utf8")) as {
        readonly name?: unknown;
        readonly version?: unknown;
      };
      if (value.name === packageName) {
        if (value.version !== expectedVersion) {
          throw new Error(
            `managed payload requires exact ${packageName} ${expectedVersion}, found ${
              String(value.version)
            }`,
          );
        }
        return current;
      }
    }
    current = dirname(current);
  }
  throw new Error(
    `managed payload could not resolve its exact ${packageName} dependency`,
  );
}

function payloadSources(repositoryRoot: string): readonly PayloadSource[] {
  return [
    ...PAYLOAD_PATHS.map((path) => ({
      destination: path,
      source: join(repositoryRoot, path),
    })),
    {
      destination: "node_modules/zod",
      source: dependencyRoot(repositoryRoot, "zod", "4.1.8"),
    },
    {
      destination: "node_modules/typebox",
      source: dependencyRoot(repositoryRoot, "typebox", "1.2.8"),
    },
  ];
}

export function hashManagedDirectory(
  directory: string,
  options: { readonly ignoreTopLevel?: readonly string[] } = {},
): string {
  const root = resolve(directory);
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("managed payload target must be a real directory");
  }
  const budget = { bytes: 0, entries: 0 };
  const files = readdirSync(root, { withFileTypes: true })
    .filter((entry) => !(options.ignoreTopLevel ?? []).includes(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) =>
      collectFiles(root, join(root, entry.name), entry.name, budget)
    );
  return digestFiles(files);
}

export function observeManagedPath(path: string): ObservedPreimage {
  if (!existsSync(path)) return { kind: "missing" };
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new Error(`managed target must not be a symbolic link: ${path}`);
  }
  if (stat.isDirectory()) {
    return {
      kind: "directory",
      sha256: hashManagedDirectory(path),
    };
  }
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
    throw new Error(`managed target is not a bounded regular file: ${path}`);
  }
  return {
    kind: "file",
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    size: stat.size,
  };
}

function sourceDigest(repositoryRoot: string): string {
  const root = resolve(repositoryRoot);
  const budget = { bytes: 0, entries: 0 };
  const files = payloadSources(root).flatMap(({ destination, source }) =>
    collectFiles(root, source, destination, budget)
  );
  return digestFiles(files);
}

export function inspectManagedRuntimePayload(
  repositoryRoot: string,
  stateRoot: string,
): ManagedRuntimePayload {
  const sourceRoot = resolve(repositoryRoot);
  const digest = sourceDigest(sourceRoot);
  return {
    activeRoot: join(stateRoot, "payloads", "generations", digest),
    digest,
    sourceRoot,
    storeRoot: join(stateRoot, "payloads", "store", digest),
  };
}

function temporarySibling(target: string): string {
  return join(
    dirname(target),
    `.${target.split(sep).at(-1) ?? "payload"}.${process.pid}.${
      randomBytes(8).toString("hex")
    }.tmp`,
  );
}

function copyPayloadSource(sourceRoot: string, target: string): void {
  for (const entry of payloadSources(sourceRoot)) {
    const source = entry.source;
    const destination = join(target, entry.destination);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    cpSync(source, destination, {
      errorOnExist: true,
      force: false,
      recursive: lstatSync(source).isDirectory(),
      verbatimSymlinks: true,
    });
  }
}

function publishExactDirectory(
  target: string,
  expectedDigest: string,
  populate: (staging: string) => void,
): void {
  if (existsSync(target)) {
    if (hashManagedDirectory(target) !== expectedDigest) {
      throw new Error(`managed payload collision at ${target}`);
    }
    return;
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const staging = temporarySibling(target);
  try {
    mkdirSync(staging, { mode: 0o700 });
    populate(staging);
    if (hashManagedDirectory(staging) !== expectedDigest) {
      throw new Error("staged managed payload digest does not match preview");
    }
    renameSync(staging, target);
  } finally {
    rmSync(staging, { force: true, recursive: true });
  }
}

export function materializeManagedRuntimePayload(
  payload: ManagedRuntimePayload,
): void {
  publishExactDirectory(payload.storeRoot, payload.digest, (staging) => {
    copyPayloadSource(payload.sourceRoot, staging);
  });
  publishExactDirectory(payload.activeRoot, payload.digest, (staging) => {
    cpSync(payload.storeRoot, staging, {
      errorOnExist: true,
      force: false,
      recursive: true,
      verbatimSymlinks: true,
    });
  });
}

export function repairManagedDirectory(input: {
  readonly digest: string;
  readonly source: string;
  readonly target: string;
}): { readonly verified: boolean; readonly detail?: string } {
  if (!isAbsolute(input.source) || !isAbsolute(input.target)) {
    return {
      detail: "managed repair source and target must be absolute",
      verified: false,
    };
  }
  if (existsSync(input.target)) {
    return {
      detail: "managed repair never overwrites an existing target",
      verified: false,
    };
  }
  try {
    if (hashManagedDirectory(input.source) !== input.digest) {
      return {
        detail: "managed repair source does not match the approved digest",
        verified: false,
      };
    }
    publishExactDirectory(input.target, input.digest, (staging) => {
      cpSync(input.source, staging, {
        errorOnExist: true,
        force: false,
        recursive: true,
        verbatimSymlinks: true,
      });
    });
    return {
      verified: hashManagedDirectory(input.target) === input.digest,
    };
  } catch (error) {
    return {
      detail: error instanceof Error ? error.message : String(error),
      verified: false,
    };
  }
}
