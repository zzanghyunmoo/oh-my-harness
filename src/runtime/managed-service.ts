import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
} from "node:fs";
import { resolve } from "node:path";

import {
  validateContractDocument,
} from "../catalog/load.js";
import {
  isAgentId,
  type AgentId,
} from "../domain/catalog.js";
import {
  readBoundedRegularFile,
  sha256File,
} from "../environment/filesystem.js";
import type { ManagedStateReceipt } from "../ports/state.js";
import {
  launchManagedRuntime,
  type ManagedLaunchBinding,
  type ManagedProcessInput,
  type ManagedProcessResult,
  type ManagedRuntimeLaunchResult,
} from "./managed-launcher.js";

const MAX_RECEIPT_BYTES = 1024 * 1024;
const MAX_CAPTURE_BYTES = 64 * 1024;

function readReceipt(
  receiptPath: string,
  repositoryRoot: string,
): ManagedStateReceipt {
  const path = resolve(receiptPath);
  if (!existsSync(path)) throw new Error("managed launch receipt is missing");
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_RECEIPT_BYTES) {
    throw new Error("managed launch receipt must be a bounded regular file");
  }
  const value = JSON.parse(
    readBoundedRegularFile(path, MAX_RECEIPT_BYTES).toString("utf8"),
  ) as unknown;
  validateContractDocument("managed-state-receipt", value, repositoryRoot);
  return value as ManagedStateReceipt;
}

function owned(
  receipt: ManagedStateReceipt,
  id: string,
  kind: ManagedStateReceipt["ownership"][number]["kind"],
): ManagedStateReceipt["ownership"][number] {
  const matches = receipt.ownership.filter(
    (entry) => entry.id === id && entry.kind === kind,
  );
  if (matches.length !== 1) {
    throw new Error(
      `managed launch receipt must record exactly one ${id} as ${kind}`,
    );
  }
  return matches[0]!;
}

export function bindingFromReceipt(input: {
  readonly receiptPath: string;
  readonly repositoryRoot: string;
  readonly runtimeId: string;
}): { readonly binding: ManagedLaunchBinding; readonly runtimeId: AgentId } {
  if (!isAgentId(input.runtimeId)) {
    throw new Error(`unsupported managed runtime: ${input.runtimeId}`);
  }
  const receipt = readReceipt(input.receiptPath, input.repositoryRoot);
  if (!receipt.desiredState.selectedAgents.includes(input.runtimeId)) {
    throw new Error(`${input.runtimeId} is not selected by the managed receipt`);
  }
  const readiness = receipt.runtimeReadiness.find(
    ({ agentId }) => agentId === input.runtimeId,
  );
  if (readiness?.state !== "ready") {
    throw new Error(`${input.runtimeId} is not ready in the managed receipt`);
  }
  const node = owned(receipt, "omh-node", "file");
  const reconciler = owned(receipt, "omh-reconciler", "file");
  const runtime = owned(receipt, `agent:${input.runtimeId}`, "executable");
  return {
    binding: {
      receiptPath: resolve(input.receiptPath),
      reconciler: {
        entrypointPath: reconciler.target,
        entrypointSha256: reconciler.digest,
        executablePath: node.target,
        executableSha256: node.digest,
      },
      runtime: {
        executablePath: runtime.target,
        executableSha256: runtime.digest,
      },
    },
    runtimeId: input.runtimeId,
  };
}

function environment(
  values: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(values));
}

function runProcess(
  input: ManagedProcessInput,
  runtimePath: string,
): Promise<ManagedProcessResult> {
  return new Promise((resolveResult, reject) => {
    const interactive = input.executablePath === runtimePath;
    const child = spawn(input.executablePath, [...input.args], {
      cwd: input.cwd,
      env: environment(input.env),
      shell: false,
      stdio: interactive ? "inherit" : ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const appendBounded = (current: string, chunk: string): string => {
      const remaining = MAX_CAPTURE_BYTES - Buffer.byteLength(current);
      if (remaining <= 0) return current;
      const bytes = Buffer.from(chunk);
      let end = Math.min(bytes.length, remaining);
      if (end < bytes.length) {
        while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
      }
      return current + bytes.subarray(0, end).toString("utf8");
    };
    if (!interactive) {
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout = appendBounded(stdout, chunk);
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr = appendBounded(stderr, chunk);
      });
      if (input.stdin !== undefined) {
        child.stdin?.end(input.stdin);
      } else {
        child.stdin?.end();
      }
    }
    if (input.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, input.timeoutMs);
      timer.unref();
    }
    child.once("error", reject);
    child.once("exit", (code) => {
      if (timer) clearTimeout(timer);
      resolveResult({
        exitCode: code ?? 1,
        stderr,
        stdout,
        ...(timedOut ? { timedOut: true } : {}),
      });
    });
  });
}

export async function runManagedRuntime(input: {
  readonly ambientEnvironment?: NodeJS.ProcessEnv;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly receiptPath: string;
  readonly repositoryRoot: string;
  readonly runtimeId: string;
}): Promise<ManagedRuntimeLaunchResult> {
  const resolved = bindingFromReceipt(input);
  const ambient = input.ambientEnvironment ?? process.env;
  return launchManagedRuntime(
    {
      ambientEnvironment: ambient,
      args: input.args,
      binding: resolved.binding,
      cwd: resolve(input.cwd ?? process.cwd()),
      runtimeId: resolved.runtimeId,
    },
    {
      sha256: async (path) => sha256File(path),
      run: async (processInput) =>
        runProcess(processInput, resolved.binding.runtime.executablePath),
    },
  );
}
