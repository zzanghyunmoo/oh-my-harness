import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
} from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import {
  isAbsolute,
  resolve,
} from "node:path";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_HTTP_BYTES = 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const STOP_GRACE_MS = 2_000;
const STOP_FORCE_MS = 2_000;
const READ_ONLY_DISCOVERY_PATHS = new Set([
  "/config",
  "/config/providers",
  "/experimental/tool/ids",
  "/global/health",
  "/lsp",
]);

export interface OpenCodeDiscoverySkill {
  readonly description: string;
  readonly id: string;
}

export interface OpenCodeDiscoveryInput {
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly executablePath: string;
  readonly expectedPluginReferences?: readonly string[];
  readonly expectedSkills: readonly OpenCodeDiscoverySkill[];
  readonly expectedToolIds?: readonly string[];
  readonly requestTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
}

export interface OpenCodeDiscoveryEvidence {
  readonly configVerified: true;
  readonly health: {
    readonly healthy: true;
    readonly version: string;
  };
  readonly lsp: readonly unknown[];
  readonly queriedPaths: readonly string[];
  readonly skillIds: readonly string[];
  readonly toolIds: readonly string[];
  readonly toolSchemaModel: string;
}

export interface OpenCodeDiscoverySession {
  get(path: string): Promise<unknown>;
  stop(): Promise<void>;
}

export interface OpenCodeDiscoveryDriver {
  start(input: OpenCodeDiscoveryInput): Promise<OpenCodeDiscoverySession>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 60_000) {
    throw new Error(`${label} must be an integer from 1 through 60000`);
  }
  return resolved;
}

function unique(values: readonly string[], label: string): readonly string[] {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} contains duplicates`);
  }
  return values;
}

function parseHealth(value: unknown): {
  readonly healthy: true;
  readonly version: string;
} {
  if (
    !isRecord(value)
    || value.healthy !== true
    || typeof value.version !== "string"
    || value.version.length === 0
    || Buffer.byteLength(value.version) > 256
  ) {
    throw new Error("OpenCode health response does not match the native contract");
  }
  return { healthy: true, version: value.version };
}

function parseToolIds(value: unknown): readonly string[] {
  const candidate = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.ids)
    ? value.ids
    : null;
  if (
    candidate === null
    || !candidate.every(
      (entry) =>
        typeof entry === "string"
        && entry.length > 0
        && Buffer.byteLength(entry) <= 256,
    )
  ) {
    throw new Error("OpenCode tool ID response does not match the native contract");
  }
  return unique([...candidate].sort(), "OpenCode tool ID response");
}

function configuredModel(
  config: unknown,
  providerConfig: unknown,
): { readonly model: string; readonly provider: string } {
  const candidates: string[] = [];
  if (isRecord(config) && typeof config.model === "string") {
    candidates.push(config.model);
  }
  if (isRecord(providerConfig) && isRecord(providerConfig.default)) {
    for (const value of Object.values(providerConfig.default)) {
      if (typeof value === "string") candidates.push(value);
    }
  }
  const selected = candidates.find((value) => {
    const slash = value.indexOf("/");
    return slash > 0 && slash < value.length - 1;
  });
  if (selected === undefined) {
    throw new Error(
      "OpenCode has no configured provider/model pair for read-only tool-schema discovery",
    );
  }
  const slash = selected.indexOf("/");
  return {
    provider: selected.slice(0, slash),
    model: selected.slice(slash + 1),
  };
}

function toolEntries(value: unknown): readonly Record<string, unknown>[] {
  const candidate = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.tools)
    ? value.tools
    : null;
  if (candidate !== null) {
    if (!candidate.every(isRecord)) {
      throw new Error("OpenCode tool schema list contains a non-object");
    }
    return candidate;
  }
  if (!isRecord(value)) {
    throw new Error("OpenCode tool schema response does not match the native contract");
  }
  return Object.entries(value).map(([id, entry]) => {
    if (!isRecord(entry)) {
      throw new Error(`OpenCode tool schema is invalid: ${id}`);
    }
    return { id, ...entry };
  });
}

function skillDescription(value: unknown): string {
  const entry = toolEntries(value).find(
    (tool) => tool.id === "skill" || tool.name === "skill",
  );
  if (entry === undefined || typeof entry.description !== "string") {
    throw new Error("OpenCode native skill tool schema is absent");
  }
  if (Buffer.byteLength(entry.description) > MAX_HTTP_BYTES) {
    throw new Error("OpenCode native skill tool description is oversized");
  }
  return entry.description;
}

function discoveredSkillIds(description: string): readonly string[] {
  const ids = [...description.matchAll(/<name>([^<]+)<\/name>/gu)]
    .map((match) => match[1] ?? "");
  if (ids.some((id) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id))) {
    throw new Error("OpenCode native skill tool contains an invalid skill name");
  }
  return unique(ids.sort(), "OpenCode native skill inventory");
}

function assertConfig(
  value: unknown,
  expectedPluginReferences: readonly string[],
): void {
  if (!isRecord(value)) {
    throw new Error("OpenCode config response does not match the native contract");
  }
  if (value.lsp === false) {
    throw new Error("OpenCode user configuration disables native LSP support");
  }
  if (expectedPluginReferences.length === 0) return;
  const plugins = value.plugin;
  if (
    !Array.isArray(plugins)
    || !plugins.every((entry) => typeof entry === "string")
    || !expectedPluginReferences.some((reference) =>
      plugins.includes(reference)
    )
  ) {
    throw new Error("OpenCode managed plugin is absent from native config");
  }
}

function assertDiscovery(
  input: OpenCodeDiscoveryInput,
  toolIds: readonly string[],
  description: string,
): readonly string[] {
  const expectedToolIds = unique(
    ["skill", ...(input.expectedToolIds ?? [])],
    "expected OpenCode tool IDs",
  );
  const missingTools = expectedToolIds.filter((id) => !toolIds.includes(id));
  if (missingTools.length > 0) {
    throw new Error(
      `OpenCode native tools are missing: ${missingTools.join(", ")}`,
    );
  }
  const legacyWorkflowTools = toolIds.filter((id) => id.startsWith("omh_"));
  if (legacyWorkflowTools.length > 0) {
    throw new Error(
      `OpenCode exposes legacy workflow tools: ${legacyWorkflowTools.join(", ")}`,
    );
  }
  const skillIds = discoveredSkillIds(description);
  const missingSkills = input.expectedSkills.filter(
    ({ id, description: expectedDescription }) =>
      !skillIds.includes(id) || !description.includes(expectedDescription),
  );
  if (missingSkills.length > 0) {
    throw new Error(
      `OpenCode native skills are missing from the skill tool description: ${
        missingSkills.map(({ id }) => id).join(", ")
      }`,
    );
  }
  return skillIds;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, milliseconds);
    timer.unref();
  });
}

async function waitForHealth(
  session: OpenCodeDiscoverySession,
  timeoutMs: number,
  queriedPaths: string[],
): Promise<ReturnType<typeof parseHealth>> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  do {
    try {
      queriedPaths.push("/global/health");
      return parseHealth(await session.get("/global/health"));
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) break;
      await delay(100);
    }
  } while (Date.now() < deadline);
  const detail = lastError instanceof Error ? lastError.message : "unknown error";
  throw new Error(`OpenCode headless server did not become healthy: ${detail}`);
}

export async function verifyOpenCodeNativeDiscovery(
  input: OpenCodeDiscoveryInput,
  driver: OpenCodeDiscoveryDriver = new NodeOpenCodeDiscoveryDriver(),
): Promise<OpenCodeDiscoveryEvidence> {
  unique(input.expectedSkills.map(({ id }) => id), "expected OpenCode skills");
  const startupTimeoutMs = boundedPositiveInteger(
    input.startupTimeoutMs,
    DEFAULT_STARTUP_TIMEOUT_MS,
    "OpenCode discovery startup timeout",
  );
  const session = await driver.start(input);
  const queriedPaths: string[] = [];
  try {
    const health = await waitForHealth(
      session,
      startupTimeoutMs,
      queriedPaths,
    );
    const basePaths = [
      "/config",
      "/config/providers",
      "/experimental/tool/ids",
      "/lsp",
    ] as const;
    const values = await Promise.all(
      basePaths.map(async (path) => {
        queriedPaths.push(path);
        return session.get(path);
      }),
    );
    const [config, providers, toolIdValue, lsp] = values;
    assertConfig(config, input.expectedPluginReferences ?? []);
    const toolIds = parseToolIds(toolIdValue);
    if (!Array.isArray(lsp)) {
      throw new Error("OpenCode LSP response does not match the native contract");
    }
    const selectedModel = configuredModel(config, providers);
    const schemaPath = `/experimental/tool?provider=${
      encodeURIComponent(selectedModel.provider)
    }&model=${encodeURIComponent(selectedModel.model)}`;
    queriedPaths.push(schemaPath);
    const description = skillDescription(await session.get(schemaPath));
    const skillIds = assertDiscovery(input, toolIds, description);
    return {
      configVerified: true,
      health,
      lsp,
      queriedPaths,
      skillIds,
      toolIds,
      toolSchemaModel: `${selectedModel.provider}/${selectedModel.model}`,
    };
  } finally {
    await session.stop();
  }
}

async function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate an OpenCode loopback port"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

function requestJson(
  port: number,
  path: string,
  timeoutMs: number,
  authorization: string,
): Promise<unknown> {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("OpenCode discovery path must be server-relative");
  }
  const parsed = new URL(path, `http://${LOOPBACK_HOST}`);
  const provider = parsed.searchParams.get("provider");
  const model = parsed.searchParams.get("model");
  const isToolSchema = parsed.pathname === "/experimental/tool"
    && parsed.searchParams.size === 2
    && typeof provider === "string"
    && provider.length > 0
    && typeof model === "string"
    && model.length > 0
    && parsed.hash.length === 0;
  if (!READ_ONLY_DISCOVERY_PATHS.has(path) && !isToolSchema) {
    throw new Error("OpenCode discovery permits only read-only native endpoints");
  }
  return new Promise((resolveValue, reject) => {
    const operation = request(
      {
        headers: { authorization },
        hostname: LOOPBACK_HOST,
        method: "GET",
        path,
        port,
        protocol: "http:",
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_HTTP_BYTES) {
            operation.destroy(
              new Error("OpenCode discovery response exceeded the size limit"),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.once("end", () => {
          if (
            response.statusCode === undefined
            || response.statusCode < 200
            || response.statusCode >= 300
          ) {
            reject(
              new Error(
                `OpenCode discovery request failed with HTTP ${
                  response.statusCode ?? "unknown"
                }`,
              ),
            );
            return;
          }
          try {
            resolveValue(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("OpenCode discovery response is not valid JSON"));
          }
        });
      },
    );
    operation.setTimeout(timeoutMs, () => {
      operation.destroy(new Error("OpenCode discovery request timed out"));
    });
    operation.once("error", reject);
    operation.end();
  });
}

function appendProcessOutput(
  chunks: Buffer[],
  chunk: Buffer,
  state: { bytes: number; error?: Error },
  child: ChildProcessWithoutNullStreams,
): void {
  state.bytes += chunk.length;
  if (state.bytes > MAX_PROCESS_OUTPUT_BYTES) {
    state.error = new Error("OpenCode server output exceeded the size limit");
    child.kill();
    return;
  }
  chunks.push(chunk);
}

async function stopChild(
  child: ChildProcessWithoutNullStreams,
  closed: Promise<void>,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    await closed;
    return;
  }
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    closed.then(() => true),
    delay(STOP_GRACE_MS).then(() => false),
  ]);
  if (!stopped) {
    child.kill("SIGKILL");
    const forced = await Promise.race([
      closed.then(() => true),
      delay(STOP_FORCE_MS).then(() => false),
    ]);
    if (!forced) {
      throw new Error("OpenCode headless server did not stop after forced termination");
    }
  }
}

export class NodeOpenCodeDiscoveryDriver implements OpenCodeDiscoveryDriver {
  async start(
    input: OpenCodeDiscoveryInput,
  ): Promise<OpenCodeDiscoverySession> {
    if (!isAbsolute(input.executablePath) || !existsSync(input.executablePath)) {
      throw new Error("OpenCode discovery executable must be an existing absolute path");
    }
    const executableStat = lstatSync(input.executablePath);
    if (executableStat.isSymbolicLink() || !executableStat.isFile()) {
      throw new Error("OpenCode discovery executable must be a regular non-symlink file");
    }
    if (!isAbsolute(input.cwd) || !existsSync(input.cwd)) {
      throw new Error("OpenCode discovery working directory must be an existing absolute path");
    }
    const cwdStat = lstatSync(input.cwd);
    if (cwdStat.isSymbolicLink() || !cwdStat.isDirectory()) {
      throw new Error("OpenCode discovery working directory must be a regular directory");
    }
    const requestTimeoutMs = boundedPositiveInteger(
      input.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      "OpenCode discovery request timeout",
    );
    const username = `omh-${randomBytes(12).toString("hex")}`;
    const password = randomBytes(32).toString("base64url");
    const authorization = `Basic ${
      Buffer.from(`${username}:${password}`, "utf8").toString("base64")
    }`;
    const port = await allocateLoopbackPort();
    const child = spawn(
      resolve(input.executablePath),
      [
        "serve",
        "--hostname",
        LOOPBACK_HOST,
        "--port",
        String(port),
      ],
      {
        cwd: resolve(input.cwd),
        env: {
          ...(input.environment ?? process.env),
          OPENCODE_SERVER_PASSWORD: password,
          OPENCODE_SERVER_USERNAME: username,
        },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    child.stdin.end();
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const outputState: { bytes: number; error?: Error } = { bytes: 0 };
    child.stdout.on("data", (chunk: Buffer) =>
      appendProcessOutput(stdout, chunk, outputState, child)
    );
    child.stderr.on("data", (chunk: Buffer) =>
      appendProcessOutput(stderr, chunk, outputState, child)
    );
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
    });
    const closed = new Promise<void>((resolveClosed) => {
      child.once("close", () => resolveClosed());
    });
    let stopped = false;
    return {
      async get(path) {
        if (outputState.error) throw outputState.error;
        if (spawnError) throw spawnError;
        if (child.exitCode !== null || child.signalCode !== null) {
          const detail = Buffer.concat([...stderr, ...stdout])
            .toString("utf8")
            .trim();
          throw new Error(
            `OpenCode headless server exited before discovery${
              detail.length > 0 ? `: ${detail}` : ""
            }`,
          );
        }
        return requestJson(port, path, requestTimeoutMs, authorization);
      },
      async stop() {
        if (stopped) return;
        stopped = true;
        await stopChild(child, closed);
      },
    };
  }
}
