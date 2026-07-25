import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";

import type { OmhResult } from "../cli/render.js";
import type { TargetPort, TargetRequest } from "./target.js";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_BUNDLE_ENTRIES = 8_192;
const DEFAULT_TIMEOUT_MS = 30_000;
const LINUX_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const TRANSPORT_SOURCES = [
  ".agents",
  ".claude-plugin",
  ".opencode",
  "dist",
  "harness",
  "plugins",
  "package.json",
  "node_modules/jsonc-parser",
  "node_modules/typebox",
  "node_modules/zod",
] as const;

export interface WslProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface WslProcessOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly maximumOutputBytes: number;
  readonly signal?: AbortSignal;
  readonly stdin?: Buffer;
  readonly timeoutMs: number;
}

export interface WslProcessRunner {
  run(
    command: string,
    args: readonly string[],
    options: WslProcessOptions,
  ): Promise<WslProcessResult>;
}

export interface WslDistribution {
  readonly name: string;
  readonly state: "Running" | "Stopped";
  readonly version: 2;
}

interface WslTargetEnvelope {
  readonly schemaVersion: "1.0.0";
  readonly targetId: "wsl-ubuntu";
  readonly result: OmhResult;
}

interface NodeProbe {
  readonly arch: "arm64" | "x64";
  readonly execPath: string;
  readonly home: string;
  readonly platform: "linux";
  readonly version: string;
}

function boundedText(value: string, maximumBytes: number, label: string): string {
  if (Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw new Error(`${label} exceeded the bounded output limit`);
  }
  return value.replaceAll("\0", "").trim();
}

function errorDetail(value: string): string {
  return value
    .replace(
      /(?:bearer|basic)\s+\S+|(?:token|password|secret|authorization)\s*[:=]\s*\S+/giu,
      "[redacted]",
    )
    .slice(0, 1_024);
}

export function parseWslDistributionList(
  output: string,
  expectedName: string,
): WslDistribution {
  const normalized = boundedText(output, 64 * 1024, "WSL distribution list");
  for (const line of normalized.split(/\r?\n/u)) {
    const match = line.match(
      /^\s*\*?\s*(.+?)\s+(Running|Stopped)\s+([12])\s*$/u,
    );
    if (!match) continue;
    const [, name, state, version] = match;
    if (name !== expectedName) continue;
    if (version !== "2") throw new Error(`${expectedName} must use WSL2`);
    return {
      name,
      state: state as "Running" | "Stopped",
      version: 2,
    };
  }
  throw new Error(`WSL distribution ${expectedName} is not installed`);
}

export function sanitizeWindowsEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = { WSLENV: "" };
  for (const key of [
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "COMSPEC",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "APPDATA",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
    "OS",
    "USERNAME",
  ]) {
    const value = environment[key];
    if (value !== undefined) safe[key] = value;
  }
  return safe;
}

function parseSemver(version: string): readonly [number, number, number] {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/u);
  if (!match) throw new Error(`WSL Node version is invalid: ${version}`);
  return [
    Number.parseInt(match[1]!, 10),
    Number.parseInt(match[2]!, 10),
    Number.parseInt(match[3]!, 10),
  ];
}

function atLeast(
  version: readonly [number, number, number],
  minimum: readonly [number, number, number],
): boolean {
  for (let index = 0; index < version.length; index += 1) {
    if (version[index]! > minimum[index]!) return true;
    if (version[index]! < minimum[index]!) return false;
  }
  return true;
}

function parseNodeProbe(output: string): NodeProbe {
  let value: unknown;
  try {
    value = JSON.parse(boundedText(output, 64 * 1024, "WSL Node probe"));
  } catch {
    throw new Error("WSL Node probe did not return bounded JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("WSL Node probe did not return an object");
  }
  const probe = value as Record<string, unknown>;
  if (
    probe.platform !== "linux"
    || !["arm64", "x64"].includes(String(probe.arch))
    || typeof probe.execPath !== "string"
    || !probe.execPath.startsWith("/")
    || probe.execPath.startsWith("/mnt/")
    || probe.execPath.toLowerCase().endsWith(".exe")
    || typeof probe.home !== "string"
    || !probe.home.startsWith("/")
    || typeof probe.version !== "string"
    || !atLeast(parseSemver(probe.version), [22, 19, 0])
  ) {
    throw new Error(
      "wsl-ubuntu requires trusted Linux Node >=22.19.0 outside /mnt",
    );
  }
  return probe as unknown as NodeProbe;
}

function writeOctal(
  header: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  const encoded = value.toString(8).padStart(length - 1, "0");
  header.write(encoded.slice(-(length - 1)), offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
}

function splitTarPath(path: string): { readonly name: string; readonly prefix: string } {
  if (Buffer.byteLength(path, "utf8") <= 100) return { name: path, prefix: "" };
  const segments = path.split("/");
  for (let index = segments.length - 1; index > 0; index -= 1) {
    const prefix = segments.slice(0, index).join("/");
    const name = segments.slice(index).join("/");
    if (
      Buffer.byteLength(prefix, "utf8") <= 155
      && Buffer.byteLength(name, "utf8") <= 100
    ) {
      return { name, prefix };
    }
  }
  throw new Error(`transport bundle path is too long: ${path}`);
}

function tarEntry(path: string, content: Buffer, mode: number): Buffer[] {
  const header = Buffer.alloc(512);
  const split = splitTarPath(path);
  header.write(split.name, 0, 100, "utf8");
  writeOctal(header, 100, 8, mode & 0o777);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, content.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  if (split.prefix) header.write(split.prefix, 345, 155, "utf8");
  writeOctal(header, 148, 8, [...header].reduce((sum, byte) => sum + byte, 0));
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
  return [header, content, padding];
}

function collectBundleFiles(
  repositoryRoot: string,
): Array<{ readonly path: string; readonly content: Buffer; readonly mode: number }> {
  const files: Array<{
    readonly path: string;
    readonly content: Buffer;
    readonly mode: number;
  }> = [];
  let totalBytes = 0;
  function visit(source: string, archivePath: string): void {
    const stat = lstatSync(source);
    if (stat.isSymbolicLink()) {
      throw new Error(`transport bundle source contains a symlink: ${source}`);
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(source, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))) {
        visit(join(source, entry.name), `${archivePath}/${entry.name}`);
      }
      return;
    }
    if (!stat.isFile()) {
      throw new Error(`transport bundle source is not a regular file: ${source}`);
    }
    totalBytes += stat.size;
    if (files.length + 1 > MAX_BUNDLE_ENTRIES || totalBytes > MAX_BUNDLE_BYTES) {
      throw new Error("transport bundle exceeds its bounded size");
    }
    files.push({
      content: readFileSync(source),
      mode: stat.mode,
      path: archivePath.split(sep).join("/"),
    });
  }
  for (const path of TRANSPORT_SOURCES) {
    const source = resolve(repositoryRoot, path);
    if (!existsSync(source)) throw new Error(`transport source is missing: ${path}`);
    const candidate = relative(resolve(repositoryRoot), source);
    if (candidate.startsWith("..") || candidate === "") {
      throw new Error(`transport source escapes the repository: ${path}`);
    }
    visit(source, path);
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export async function createWslTransportBundle(
  repositoryRoot: string,
): Promise<Buffer> {
  const chunks = collectBundleFiles(repositoryRoot)
    .flatMap(({ path, content, mode }) => tarEntry(path, content, mode));
  chunks.push(Buffer.alloc(1_024));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

class NodeWslProcessRunner implements WslProcessRunner {
  async run(
    command: string,
    args: readonly string[],
    options: WslProcessOptions,
  ): Promise<WslProcessResult> {
    return new Promise((resolveResult, reject) => {
      const child = spawn(command, [...args], {
        env: options.environment,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let totalBytes = 0;
      let settled = false;
      const finishError = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
        child.kill();
        reject(error);
      };
      const append = (chunks: Buffer[], chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > options.maximumOutputBytes) {
          finishError(new Error("WSL command exceeded the bounded output limit"));
          return;
        }
        chunks.push(chunk);
      };
      const abort = () => finishError(new Error("WSL command was cancelled"));
      const timeout = setTimeout(
        () => finishError(new Error("WSL command timed out")),
        options.timeoutMs,
      );
      options.signal?.addEventListener("abort", abort, { once: true });
      child.once("error", finishError);
      child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
        resolveResult({
          exitCode: code ?? 1,
          stderr: Buffer.concat(stderr).toString("utf8"),
          stdout: Buffer.concat(stdout).toString("utf8"),
        });
      });
      if (options.stdin === undefined) child.stdin.end();
      else child.stdin.end(options.stdin);
    });
  }
}

function resolveWslExecutable(environment: NodeJS.ProcessEnv): string {
  const systemRoot = environment.SystemRoot ?? environment.WINDIR;
  if (!systemRoot) throw new Error("SystemRoot is required to locate trusted wsl.exe");
  const executable = join(systemRoot, "System32", "wsl.exe");
  if (!existsSync(executable)) throw new Error(`trusted wsl.exe is missing: ${executable}`);
  const stat = lstatSync(executable);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`trusted wsl.exe is not a regular file: ${executable}`);
  }
  return executable;
}

function unavailableResult(argv: readonly string[], detail: string): OmhResult {
  const mutationPreview = argv[0] === "setup"
    || (argv[0] === "agents" && argv[1] === "install")
    || (argv[0] === "tools" && argv[1] === "install");
  return {
    command: argv[0] ?? "status",
    exitCode: mutationPreview ? 3 : 6,
    output: detail,
    state: mutationPreview ? "blocked" : "unverifiable",
  };
}

export class WslTargetPort implements TargetPort {
  readonly bundle: (repositoryRoot: string) => Promise<Buffer>;
  readonly environment: NodeJS.ProcessEnv;
  readonly executable: string;
  readonly runner: WslProcessRunner;
  readonly timeoutMs: number;

  constructor(options: {
    readonly bundle?: (repositoryRoot: string) => Promise<Buffer>;
    readonly environment?: NodeJS.ProcessEnv;
    readonly executable?: string;
    readonly runner?: WslProcessRunner;
    readonly timeoutMs?: number;
  } = {}) {
    this.environment = options.environment ?? process.env;
    this.executable = options.executable
      ?? resolveWslExecutable(this.environment);
    this.runner = options.runner ?? new NodeWslProcessRunner();
    this.bundle = options.bundle ?? createWslTransportBundle;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async execute(
    args: readonly string[],
    request: TargetRequest,
    stdin?: Buffer,
  ): Promise<WslProcessResult> {
    return this.runner.run(this.executable, args, {
      environment: sanitizeWindowsEnvironment(this.environment),
      maximumOutputBytes: MAX_OUTPUT_BYTES,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(stdin === undefined ? {} : { stdin }),
      timeoutMs: this.timeoutMs,
    });
  }

  private async required(
    args: readonly string[],
    request: TargetRequest,
    label: string,
    stdin?: Buffer,
  ): Promise<string> {
    const result = await this.execute(args, request, stdin);
    if (result.exitCode !== 0) {
      throw new Error(`${label} failed: ${errorDetail(result.stderr)}`);
    }
    return boundedText(result.stdout, MAX_OUTPUT_BYTES, label);
  }

  async run(request: TargetRequest): Promise<OmhResult> {
    if (request.targetId !== "wsl-ubuntu") {
      throw new Error(`WslTargetPort cannot execute ${request.targetId}`);
    }
    let distribution: WslDistribution;
    try {
      distribution = parseWslDistributionList(
        await this.required(["--list", "--verbose"], request, "WSL distribution list"),
        "Ubuntu",
      );
    } catch (error) {
      return unavailableResult(
        request.argv,
        error instanceof Error ? error.message : String(error),
      );
    }
    if (distribution.state === "Stopped" && !request.startIfStopped) {
      return unavailableResult(
        request.argv,
        "wsl-ubuntu is stopped; explicit setup preview or apply may start it",
      );
    }

    let nodeProbe: NodeProbe;
    try {
      nodeProbe = parseNodeProbe(
        await this.required(
          [
            "--distribution",
            "Ubuntu",
            "--exec",
            "/usr/bin/env",
            "-i",
            `PATH=${LINUX_PATH}`,
            "node",
            "--input-type=module",
            "--eval",
            "import os from 'node:os';process.stdout.write(JSON.stringify({arch:process.arch,execPath:process.execPath,home:os.homedir(),platform:process.platform,version:process.versions.node}))",
          ],
          request,
          "WSL Node probe",
        ),
      );
      const translatedRepository = await this.required(
        [
          "--distribution",
          "Ubuntu",
          "--exec",
          "/usr/bin/wslpath",
          "-a",
          "-u",
          request.repositoryRoot,
        ],
        request,
        "WSL repository path translation",
      );
      if (!/^\/mnt\/[a-z]\//u.test(translatedRepository)) {
        throw new Error("WSL repository path translation returned an unsafe path");
      }
    } catch (error) {
      return unavailableResult(
        request.argv,
        error instanceof Error ? error.message : String(error),
      );
    }
    const temporary = await this.required(
      [
        "--distribution",
        "Ubuntu",
        "--exec",
        "/usr/bin/mktemp",
        "--directory",
        "/tmp/omh-transport.XXXXXXXX",
      ],
      request,
      "WSL transport staging",
    );
    if (!/^\/tmp\/omh-transport\.[A-Za-z0-9]+$/u.test(temporary)) {
      throw new Error("WSL transport staging returned an unsafe path");
    }

    let primaryError: unknown;
    try {
      const archive = await this.bundle(request.repositoryRoot);
      await this.required(
        [
          "--distribution",
          "Ubuntu",
          "--exec",
          "/bin/tar",
          "--extract",
          "--gzip",
          "--file",
          "-",
          "--directory",
          temporary,
          "--no-same-owner",
          "--no-same-permissions",
        ],
        request,
        "WSL transport extraction",
        archive,
      );
      const execution = await this.execute(
        [
          "--distribution",
          "Ubuntu",
          "--exec",
          "/usr/bin/env",
          "-i",
          `HOME=${nodeProbe.home}`,
          `PATH=${LINUX_PATH}`,
          nodeProbe.execPath,
          `${temporary}/dist/cli/wsl-bootstrap.js`,
          "--repository-root",
          temporary,
          "--",
          ...request.argv,
        ],
        request,
      );
      let envelope: unknown;
      try {
        envelope = JSON.parse(
          boundedText(execution.stdout, MAX_OUTPUT_BYTES, "WSL target result"),
        );
      } catch {
        throw new Error("WSL target did not return bounded JSON");
      }
      if (
        !envelope
        || typeof envelope !== "object"
        || Array.isArray(envelope)
        || (envelope as Record<string, unknown>).schemaVersion !== "1.0.0"
      ) {
        throw new Error("WSL target did not return a valid envelope");
      }
      const typed = envelope as unknown as WslTargetEnvelope;
      if (typed.targetId !== request.targetId) {
        throw new Error("WSL target identity did not match the request");
      }
      if (!typed.result || typeof typed.result !== "object") {
        throw new Error("WSL target result is missing");
      }
      return typed.result;
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        await this.required(
          [
            "--distribution",
            "Ubuntu",
            "--exec",
            "/bin/rm",
            "--recursive",
            "--force",
            "--",
            temporary,
          ],
          request,
          "WSL transport cleanup",
        );
      } catch (cleanupError) {
        if (primaryError === undefined) throw cleanupError;
      }
    }
  }
}
