import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import type { AgentId } from "../domain/catalog.js";
import {
  readBoundedRegularFile,
  sha256File as hashFile,
} from "../environment/filesystem.js";
import type {
  ApplyPlan,
  ObservedPreimage,
  PlanAction,
} from "../planning/actions.js";
import { createApplyPlan } from "../planning/preview.js";

export type LegacyOwnership = "proven" | "suspected" | "user-owned";

export interface LegacyStateItem {
  readonly id: string;
  readonly kind:
    | "pi-runtime"
    | "compound-engineering"
    | "runtime-registration"
    | "static-tool-profile"
    | "legacy-product-surface";
  readonly target: string;
  readonly ownership: LegacyOwnership;
  readonly evidence: string;
  readonly preimage: ObservedPreimage;
}

export interface V1MigrationReport {
  readonly schemaVersion: "2.0.0";
  readonly kind: "v1-migration-report";
  readonly installRoot: string;
  readonly repositoryRoot: string;
  readonly items: readonly LegacyStateItem[];
  readonly removable: readonly LegacyStateItem[];
  readonly preserved: readonly LegacyStateItem[];
}

interface LegacyReceipt {
  readonly schemaVersion?: unknown;
  readonly kind?: unknown;
  readonly identity?: unknown;
  readonly runtimeId?: unknown;
  readonly compoundEngineeringCommit?: unknown;
  readonly payloadSha256?: unknown;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_LEGACY_ENTRIES = 4_096;
const MAX_LEGACY_FILE_BYTES = 16 * 1024 * 1024;
const MAX_LEGACY_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_LEGACY_RECEIPT_BYTES = 1024 * 1024;

function sha256File(path: string): string {
  return hashFile(path);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function escapes(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function directoryEntries(
  root: string,
  current = root,
  entries: Array<Record<string, unknown>> = [],
  budget: { entries: number; bytes: number } = { entries: 0, bytes: 0 },
): Array<Record<string, unknown>> {
  for (const name of readdirSync(current).sort()) {
    const path = join(current, name);
    const rel = relative(root, path).split(sep).join("/");
    if (rel === ".oh-my-harness-install.json") continue;
    const stat = lstatSync(path);
    budget.entries += 1;
    if (budget.entries > MAX_LEGACY_ENTRIES) {
      throw new Error("legacy payload has too many entries");
    }
    if (stat.isSymbolicLink()) {
      const link = readlinkSync(path);
      const target = resolve(dirname(path), link);
      if (isAbsolute(link) || escapes(root, target)) {
        throw new Error(`legacy payload contains an escaping symbolic link: ${path}`);
      }
      entries.push({ path: rel, symlink: link });
    } else if (stat.isDirectory()) {
      directoryEntries(root, path, entries, budget);
    } else if (stat.isFile()) {
      if (stat.size > MAX_LEGACY_FILE_BYTES) {
        throw new Error(`legacy payload contains an oversized file: ${path}`);
      }
      budget.bytes += stat.size;
      if (budget.bytes > MAX_LEGACY_TOTAL_BYTES) {
        throw new Error("legacy payload exceeds the total byte limit");
      }
      entries.push({ path: rel, sha256: sha256File(path), size: stat.size });
    } else {
      throw new Error(`legacy payload contains a non-regular entry: ${path}`);
    }
  }
  return entries;
}

function observe(path: string): ObservedPreimage {
  if (!existsSync(path)) return { kind: "missing" };
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    return {
      kind: "file",
      sha256: createHash("sha256").update(readlinkSync(path), "utf8").digest("hex"),
      size: Buffer.byteLength(readlinkSync(path)),
    };
  }
  if (stat.isFile()) {
    if (stat.size > MAX_LEGACY_FILE_BYTES) {
      throw new Error(`legacy target is oversized: ${path}`);
    }
    return { kind: "file", sha256: sha256File(path), size: stat.size };
  }
  if (stat.isDirectory()) {
    const encoded = stableJson(directoryEntries(path));
    return {
      kind: "file",
      sha256: createHash("sha256").update(encoded, "utf8").digest("hex"),
      size: Buffer.byteLength(encoded),
    };
  }
  throw new Error(`legacy target is not a regular file or directory: ${path}`);
}

function readReceipt(path: string): LegacyReceipt | null {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink()
    || !stat.isFile()
    || stat.size > MAX_LEGACY_RECEIPT_BYTES
  ) {
    return null;
  }
  try {
    const value = JSON.parse(
      readBoundedRegularFile(path, MAX_LEGACY_RECEIPT_BYTES).toString("utf8"),
    ) as unknown;
    return value !== null && typeof value === "object"
      ? value as LegacyReceipt
      : null;
  } catch {
    return null;
  }
}

function item(
  id: string,
  kind: LegacyStateItem["kind"],
  target: string,
  ownership: LegacyOwnership,
  evidence: string,
): LegacyStateItem {
  return { id, kind, target, ownership, evidence, preimage: observe(target) };
}

function compoundItems(installRoot: string): LegacyStateItem[] {
  const root = join(installRoot, "packages", "compound-engineering-plugin");
  if (!existsSync(root)) return [];
  const results: LegacyStateItem[] = [];
  const visit = (path: string): void => {
    const receiptPath = join(path, ".oh-my-harness-install.json");
    const receipt = readReceipt(receiptPath);
    if (receipt?.kind === "compound-engineering") {
      let ownership: LegacyOwnership = "suspected";
      let evidence = "Compound Engineering receipt exists but content identity is unverifiable";
      if (
        typeof receipt.payloadSha256 === "string"
        && SHA256_PATTERN.test(receipt.payloadSha256)
      ) {
        try {
          const digest = createHash("sha256")
            .update(stableJson(directoryEntries(path)), "utf8")
            .digest("hex");
          if (digest === receipt.payloadSha256) {
            ownership = "proven";
            evidence = "exact v1 Compound Engineering receipt and payload digest";
          } else {
            ownership = "user-owned";
            evidence = "v1 payload has additional or modified content";
          }
        } catch (error) {
          ownership = "user-owned";
          evidence = error instanceof Error ? error.message : String(error);
        }
      }
      results.push(item(
        `compound-engineering-${results.length + 1}`,
        "compound-engineering",
        path,
        ownership,
        evidence,
      ));
      return;
    }
    let hasUnreceiptedContent = false;
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name);
      if (lstatSync(child).isDirectory() && !lstatSync(child).isSymbolicLink()) {
        visit(child);
      } else {
        hasUnreceiptedContent = true;
      }
    }
    if (hasUnreceiptedContent) {
      results.push(item(
        `compound-engineering-unverified-${results.length + 1}`,
        "compound-engineering",
        path,
        "suspected",
        "legacy package content exists without an exact harness receipt",
      ));
    }
  };
  visit(root);
  if (results.length === 0) {
    results.push(item(
      "compound-engineering-unverified",
      "compound-engineering",
      root,
      "suspected",
      "legacy package path exists without an exact harness receipt",
    ));
  }
  return results;
}

export function inspectV1Migration(input: {
  readonly installRoot: string;
  readonly repositoryRoot: string;
}): V1MigrationReport {
  const installRoot = resolve(input.installRoot);
  const repositoryRoot = resolve(input.repositoryRoot);
  const items: LegacyStateItem[] = [];

  const piReceiptPath = join(installRoot, "receipts", "pi.json");
  if (existsSync(piReceiptPath)) {
    const receipt = readReceipt(piReceiptPath);
    const proven = receipt?.kind === "runtime-registration"
      && receipt.runtimeId === "pi"
      && typeof receipt.identity === "string"
      && receipt.identity.startsWith("pi@");
    items.push(item(
      "pi-runtime-receipt",
      "pi-runtime",
      piReceiptPath,
      proven ? "proven" : "suspected",
      proven
        ? "exact v1 Pi runtime-registration receipt"
        : "Pi receipt path exists but its identity is missing or damaged",
    ));
  }

  items.push(...compoundItems(installRoot));

  for (const [id, path, kind] of [
    [
      "pi-adapter",
      join(repositoryRoot, "harness", "adapters", "pi.json"),
      "legacy-product-surface",
    ],
    [
      "static-runtime-tools",
      join(
        repositoryRoot,
        "plugins",
        "oh-my-harness",
        "profiles",
        "runtime-tools.json",
      ),
      "static-tool-profile",
    ],
  ] as const) {
    if (existsSync(path)) {
      items.push(item(
        id,
        kind,
        path,
        "proven",
        "tracked v1 repository product surface",
      ));
    }
  }

  return {
    schemaVersion: "2.0.0",
    kind: "v1-migration-report",
    installRoot,
    repositoryRoot,
    items,
    removable: items.filter(({ ownership }) => ownership === "proven"),
    preserved: items.filter(({ ownership }) => ownership !== "proven"),
  };
}

export function createV1RemovalPreview(input: {
  readonly report: V1MigrationReport;
  readonly catalogRevision: string;
  readonly profileId: string;
  readonly selectedAgents: readonly AgentId[];
  readonly os: string;
  readonly arch: string;
}): ApplyPlan {
  const actions: PlanAction[] = input.report.removable.map((entry) => ({
    id: `remove:${entry.id}`,
    kind: "remove",
    required: false,
    target: entry.target,
    preimage: entry.preimage,
    payload: {
      legacyKind: entry.kind,
      ownershipEvidence: entry.evidence,
    },
  }));
  return createApplyPlan({
    catalogRevision: input.catalogRevision,
    desiredState: {
      profileId: input.profileId,
      selectedAgents: input.selectedAgents,
    },
    platform: { os: input.os, arch: input.arch },
    observedState: {
      migrationKind: input.report.kind,
      preserved: input.report.preserved.map(({ id, ownership }) => ({
        id,
        ownership,
      })),
    },
    preflights: input.report.preserved.map((entry) => ({
      id: `preserve:${entry.id}`,
      required: false,
      status: "optional-gap",
      detail: `${entry.ownership}: ${entry.evidence}`,
    })),
    actions,
  });
}
