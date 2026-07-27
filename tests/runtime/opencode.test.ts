import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  inspectManagedRuntimePayload,
  materializeManagedRuntimePayload,
} from "../../dist/install/managed-payload.js";
import {
  OPEN_CODE_LSP_CAPABILITY_IDS,
  OPEN_CODE_WORKFLOW_CAPABILITY_IDS,
  applyOpenCodeNativeConfig,
  createFileOpenCodeRuntimeDependencies,
  createOpenCodeLifecycleHooks,
  evaluateOpenCodeNativeReadiness,
  loadOpenCodeCapabilityDefinitions,
  renderOpenCodeRuntimeContext,
  resolveOpenCodePackageRoot,
  type OpenCodeRuntimeContext,
  type OpenCodeStartupInspection,
} from "../../dist/runtime/opencode.js";
import {
  NodeOpenCodeDiscoveryDriver,
  verifyOpenCodeNativeDiscovery,
  type OpenCodeDiscoverySession,
} from "../../dist/runtime/opencode-discovery.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PLUGIN_PATH = join(
  REPOSITORY_ROOT,
  ".opencode",
  "plugins",
  "oh-my-harness.js",
);

function readyContext(): OpenCodeRuntimeContext {
  return {
    schemaVersion: "2.0.0",
    kind: "runtime-context",
    runtimeId: "opencode",
    mode: "ready",
    profileId: "personal",
    catalogRevision: "a".repeat(64),
    selectedAgents: ["claude-code", "opencode", "codex"],
    reconciliation: {
      state: "no-drift",
      repaired: [],
      pendingApproval: [],
      conflicts: [],
    },
    packages: [
      { id: "linear", required: true, state: "installed-unconfigured" },
      { id: "notion", required: true, state: "ready" },
      { id: "github", required: true, state: "ready" },
      { id: "jira", required: false, state: "optional-gap" },
    ],
    capabilities: [
      ...OPEN_CODE_LSP_CAPABILITY_IDS.map((id) => ({
        id,
        state: "ready" as const,
        source: "official" as const,
      })),
      ...OPEN_CODE_WORKFLOW_CAPABILITY_IDS.map((id) => ({
        id,
        state: "ready" as const,
        source: "managed" as const,
      })),
    ],
    remediation: [],
  };
}

function readyStartup(
  values: Partial<OpenCodeStartupInspection> = {},
): OpenCodeStartupInspection {
  return {
    ready: true,
    restartRequired: false,
    context: "approved local state is ready",
    diagnostics: [],
    ...values,
  };
}

test("U10 maps every requested capability to an OpenCode-native surface", () => {
  assert.deepEqual(OPEN_CODE_LSP_CAPABILITY_IDS, [
    "lsp-jdtls",
    "lsp-kotlin",
    "lsp-csharp",
    "lsp-clangd",
    "lsp-gopls",
    "lsp-pyright",
    "lsp-typescript",
  ]);
  assert.deepEqual(OPEN_CODE_WORKFLOW_CAPABILITY_IDS, [
    "goal",
    "deep-research",
    "ideation",
    "brainstorm",
    "plan",
    "code-review",
    "doc-review",
    "skill-creator",
    "ralph-loop",
    "security-guidance",
  ]);

  const definitions = loadOpenCodeCapabilityDefinitions(REPOSITORY_ROOT);
  assert.deepEqual(
    definitions.map(({ id }) => id),
    OPEN_CODE_WORKFLOW_CAPABILITY_IDS,
  );
  assert.equal(
    definitions.every(
      ({ content, description }) =>
        content.includes("# ")
        && description.length > 0,
    ),
    true,
  );

  const readiness = evaluateOpenCodeNativeReadiness(
    readyContext(),
    readyStartup(),
  );
  assert.equal(readiness.state, "ready");
  assert.deepEqual(readiness.unavailableCapabilities, []);
});

test("U10 partial and unsupported native mappings remain explicit", () => {
  const pending = structuredClone(readyContext());
  pending.capabilities[0] = {
    id: "lsp-jdtls",
    state: "pending",
    source: "official",
  };
  assert.equal(
    evaluateOpenCodeNativeReadiness(pending, readyStartup()).state,
    "degraded",
  );

  const unsupported = structuredClone(readyContext());
  unsupported.capabilities[0] = {
    id: "lsp-jdtls",
    state: "unsupported",
    source: "official",
  };
  const result = evaluateOpenCodeNativeReadiness(
    unsupported,
    readyStartup(),
  );
  assert.equal(result.state, "unsupported");
  assert.deepEqual(result.unavailableCapabilities, ["lsp-jdtls"]);
});

test("U10 chat and system hooks inject current context on every model turn", async () => {
  let inspections = 0;
  let loads = 0;
  let restartRequired = false;
  const hooks = createOpenCodeLifecycleHooks({
    directory: "/workspace",
    loadContext: async () => {
      loads += 1;
      const context = readyContext();
      return { json: context, text: renderOpenCodeRuntimeContext(context) };
    },
    inspectStartup: async () => {
      inspections += 1;
      return readyStartup({
        restartRequired,
        diagnostics: restartRequired ? ["pinned content repaired"] : [],
      });
    },
  });

  await hooks["chat.message"]?.(
    { sessionID: "session-1" },
    { message: {} as never, parts: [] },
  );
  const first = { system: ["base system"] };
  await hooks["experimental.chat.system.transform"]?.(
    { sessionID: "session-1", model: {} as never },
    first,
  );
  assert.equal(first.system.length, 2);
  assert.match(first.system[1] ?? "", /profile: personal/);
  assert.match(first.system[1] ?? "", /catalog revision: a{64}/);
  assert.match(
    first.system[1] ?? "",
    /selected agents: claude-code, opencode, codex/,
  );
  assert.match(first.system[1] ?? "", /capabilities:/);
  assert.match(first.system[1] ?? "", /packages:/);
  assert.match(first.system[1] ?? "", /optional gaps: jira/);

  restartRequired = true;
  await hooks["chat.message"]?.(
    { sessionID: "session-1" },
    { message: {} as never, parts: [] },
  );
  const second = { system: [] as string[] };
  await hooks["experimental.chat.system.transform"]?.(
    { sessionID: "session-1", model: {} as never },
    second,
  );
  assert.match(second.system[0] ?? "", /current session ready: no/);
  assert.match(second.system[0] ?? "", /restart required: yes/);
  assert.match(second.system[0] ?? "", /pinned content repaired/);

  const compacting = { context: [] as string[] };
  await hooks["experimental.session.compacting"]?.(
    { sessionID: "session-1" },
    compacting,
  );
  assert.match(compacting.context[0] ?? "", /profile: personal/);
  assert.ok(inspections >= 3);
  assert.ok(loads >= 3);
});

test("U10 file-backed direct launch fails closed on absent or corrupt state", async () => {
  const root = mkdtempSync(join(tmpdir(), "omh-opencode-state-"));
  try {
    const dependencies = createFileOpenCodeRuntimeDependencies({
      env: { OH_MY_HARNESS_STATE_ROOT: root },
    });
    const missing = await dependencies.loadContext("/arbitrary/workspace");
    assert.equal(missing.json.mode, "status-only");
    assert.match(missing.text, /unverifiable/);
    assert.match(missing.text, /omh setup --profile <profile-id>/);
    const startup = await dependencies.inspectStartup(
      "/arbitrary/workspace",
    );
    assert.equal(startup.ready, false);
    assert.equal(startup.restartRequired, false);

    mkdirSync(join(root, "runtime", "opencode"), { recursive: true });
    writeFileSync(
      join(root, "runtime", "opencode", "context.json"),
      "{broken",
    );
    const corrupt = await dependencies.loadContext("/arbitrary/workspace");
    assert.equal(corrupt.json.mode, "status-only");
    assert.match(corrupt.text, /corrupt runtime context snapshot/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("U10 file-backed snapshots reject oversized, unknown, and symlinked context", async () => {
  const root = mkdtempSync(join(tmpdir(), "omh-opencode-bounded-state-"));
  const runtimeRoot = join(root, "runtime", "opencode");
  const contextPath = join(runtimeRoot, "context.json");
  try {
    mkdirSync(runtimeRoot, { recursive: true });
    const dependencies = createFileOpenCodeRuntimeDependencies({
      stateRoot: root,
    });

    writeFileSync(contextPath, "x".repeat(64 * 1024 + 1));
    const oversized = await dependencies.loadContext("/arbitrary/workspace");
    assert.equal(oversized.json.mode, "status-only");
    assert.match(oversized.text, /bounded size limit/u);

    writeFileSync(
      contextPath,
      JSON.stringify({
        ...readyContext(),
        capabilities: [
          ...readyContext().capabilities,
          { id: "unknown-capability", state: "ready", source: "managed" },
        ],
      }),
    );
    const unknown = await dependencies.loadContext("/arbitrary/workspace");
    assert.equal(unknown.json.mode, "status-only");
    assert.match(unknown.text, /invalid capability/u);

    const outside = process.platform === "win32"
      ? join(root, "outside")
      : join(root, "outside.json");
    if (process.platform === "win32") mkdirSync(outside);
    else writeFileSync(outside, JSON.stringify(readyContext()));
    rmSync(contextPath);
    symlinkSync(
      outside,
      contextPath,
      process.platform === "win32" ? "junction" : "file",
    );
    const symlinked = await dependencies.loadContext("/arbitrary/workspace");
    assert.equal(symlinked.json.mode, "status-only");
    assert.match(symlinked.text, /regular non-symlink file|symbolic link/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("U10 direct-launch snapshots are gated by native receipt reconciliation", async () => {
  const root = mkdtempSync(join(tmpdir(), "omh-opencode-refresh-"));
  try {
    let refreshes = 0;
    const dependencies = createFileOpenCodeRuntimeDependencies({
      beforeRead: async () => {
        refreshes += 1;
        throw new Error("receipt identity did not verify");
      },
      stateRoot: root,
    });
    const context = await dependencies.loadContext("/arbitrary/workspace");
    const startup = await dependencies.inspectStartup("/arbitrary/workspace");
    assert.equal(refreshes, 2);
    assert.equal(context.json.mode, "status-only");
    assert.match(context.text, /receipt-driven startup reconciliation failed/);
    assert.equal(startup.ready, false);
    assert.match(startup.context, /reconciliation failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("U10 native config enables selected built-in LSPs without overriding a user disable", () => {
  const enabled: { lsp?: false | Record<string, unknown> } = {};
  assert.deepEqual(
    applyOpenCodeNativeConfig(enabled, readyContext()),
    { configured: true, diagnostics: [] },
  );
  assert.deepEqual(enabled.lsp, {});

  const disabled: { lsp?: false | Record<string, unknown> } = { lsp: false };
  const conflict = applyOpenCodeNativeConfig(disabled, readyContext());
  assert.equal(conflict.configured, false);
  assert.match(conflict.diagnostics[0] ?? "", /user configuration disables LSP/);
  assert.equal(disabled.lsp, false);

  const partiallyDisabled = {
    lsp: { typescript: { disabled: true } },
  };
  const partialConflict = applyOpenCodeNativeConfig(
    partiallyDisabled,
    readyContext(),
  );
  assert.equal(partialConflict.configured, false);
  assert.match(
    partialConflict.diagnostics[0] ?? "",
    /lsp-typescript.*user configuration/,
  );
  assert.deepEqual(partiallyDisabled.lsp, {
    typescript: { disabled: true },
  });
});

test("U5 verifies OpenCode native skill discovery without a session or prompt", async () => {
  const paths: string[] = [];
  let stopped = false;
  const definitions = loadOpenCodeCapabilityDefinitions(REPOSITORY_ROOT);
  const session: OpenCodeDiscoverySession = {
    async get(path) {
      paths.push(path);
      if (path === "/global/health") {
        return { healthy: true, version: "1.18.0" };
      }
      if (path === "/config") {
        return {
          model: "fixture/model",
          plugin: ["file:///managed/.opencode/plugins/oh-my-harness.js"],
          lsp: {},
        };
      }
      if (path === "/config/providers") {
        return { providers: [], default: { build: "fixture/model" } };
      }
      if (path === "/experimental/tool/ids") {
        return [
          "skill",
          "workspace_cli_setup",
          "workspace_cli_status",
        ];
      }
      if (path === "/lsp") return [];
      if (
        path
        === "/experimental/tool?provider=fixture&model=model"
      ) {
        return definitions.map(({ id, description }) =>
          id === "goal"
            ? {
                id: "skill",
                description: [
                  "<available_skills>",
                  ...definitions.flatMap((definition) => [
                    "<skill>",
                    `<name>${definition.id}</name>`,
                    `<description>${definition.description}</description>`,
                    "</skill>",
                  ]),
                  "</available_skills>",
                ].join("\n"),
              }
            : { id: `fixture-${id}`, description }
        );
      }
      throw new Error(`unexpected path: ${path}`);
    },
    async stop() {
      stopped = true;
    },
  };

  const evidence = await verifyOpenCodeNativeDiscovery(
    {
      cwd: REPOSITORY_ROOT,
      executablePath: process.execPath,
      expectedPluginReferences: [
        "file:///managed/.opencode/plugins/oh-my-harness.js",
      ],
      expectedSkills: definitions,
      expectedToolIds: [
        "workspace_cli_setup",
        "workspace_cli_status",
      ],
    },
    { async start() { return session; } },
  );

  assert.equal(stopped, true);
  assert.deepEqual(evidence.skillIds, [...OPEN_CODE_WORKFLOW_CAPABILITY_IDS].sort());
  assert.equal(evidence.toolSchemaModel, "fixture/model");
  assert.equal(paths.some((path) => path.startsWith("/session")), false);
  assert.equal(paths.some((path) => path.includes("prompt")), false);
});

test("U5 OpenCode discovery fails closed and always stops the server", async () => {
  let stopped = false;
  const session: OpenCodeDiscoverySession = {
    async get(path) {
      if (path === "/global/health") {
        return { healthy: true, version: "1.18.0" };
      }
      if (path === "/config") return { model: "fixture/model" };
      if (path === "/config/providers") return { default: {} };
      if (path === "/experimental/tool/ids") return ["skill", "omh_plan"];
      if (path === "/lsp") return [];
      return [{
        id: "skill",
        description:
          "<available_skills><skill><name>plan</name><description>Plan</description></skill></available_skills>",
      }];
    },
    async stop() {
      stopped = true;
    },
  };

  await assert.rejects(
    verifyOpenCodeNativeDiscovery(
      {
        cwd: REPOSITORY_ROOT,
        executablePath: process.execPath,
        expectedSkills: [{ id: "plan", description: "Plan" }],
      },
      { async start() { return session; } },
    ),
    /legacy workflow tools/u,
  );
  assert.equal(stopped, true);
});

test("U5 OpenCode discovery uses per-run auth and rejects write endpoints", async () => {
  const root = mkdtempSync(join(tmpdir(), "omh-opencode-auth-"));
  const executable = join(root, "serve");
  writeFileSync(
    executable,
    String.raw`
const { createServer, request } = require("node:http");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const expected = "Basic " + Buffer.from(
  process.env.OPENCODE_SERVER_USERNAME + ":" + process.env.OPENCODE_SERVER_PASSWORD,
).toString("base64");
let rejectedUnauthenticated = false;
const server = createServer((incoming, response) => {
  if (incoming.headers.authorization !== expected) {
    rejectedUnauthenticated = true;
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  if (!rejectedUnauthenticated) {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "self-check pending" }));
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    ambientOverridden:
      process.env.OPENCODE_SERVER_PASSWORD !== "ambient-password"
      && process.env.OPENCODE_SERVER_USERNAME !== "ambient-user",
    healthy: true,
    version: "fixture",
  }));
});
server.listen(port, "127.0.0.1", () => {
  const operation = request({
    hostname: "127.0.0.1",
    method: "GET",
    path: "/global/health",
    port,
  }, (response) => response.resume());
  operation.end();
});
`,
  );
  const session = await new NodeOpenCodeDiscoveryDriver().start({
    cwd: root,
    environment: {
      ...process.env,
      OPENCODE_SERVER_PASSWORD: "ambient-password",
      OPENCODE_SERVER_USERNAME: "ambient-user",
    },
    executablePath: process.execPath,
    expectedSkills: [],
    requestTimeoutMs: 1_000,
  });
  try {
    let health: unknown;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        health = await session.get("/global/health");
        break;
      } catch {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      }
    }
    assert.deepEqual(health, {
      ambientOverridden: true,
      healthy: true,
      version: "fixture",
    });
    await assert.rejects(
      session.get("/session"),
      /only read-only native endpoints/u,
    );
  } finally {
    await session.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("U10 packaged plugin resolves from import.meta.url and runs from arbitrary CWD", async () => {
  const originalCwd = process.cwd();
  const elsewhere = mkdtempSync(join(tmpdir(), "omh-opencode-cwd-"));
  try {
    process.chdir(elsewhere);
    assert.equal(
      resolveOpenCodePackageRoot(pathToFileURL(PLUGIN_PATH).href),
      REPOSITORY_ROOT,
    );
    const module = await import(
      `${pathToFileURL(PLUGIN_PATH).href}?u10=${Date.now()}`
    );
    let injectedContext = readyContext();
    const plugin = module.createOpenCodePlugin({
      loadContext: async () => {
        return {
          json: injectedContext,
          text: renderOpenCodeRuntimeContext(injectedContext),
        };
      },
      inspectStartup: async () => readyStartup(),
    });
    const hooks = await plugin({
      directory: elsewhere,
      worktree: elsewhere,
      project: {},
      client: {},
      experimental_workspace: { register() {} },
      serverUrl: new URL("http://localhost"),
      $: undefined,
    });
    const names = Object.keys(hooks.tool);
    assert.equal(names.includes("workspace_cli_status"), true);
    assert.equal(names.some((name) => name.startsWith("omh_")), false);

    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"](
      { sessionID: "session", model: {} },
      output,
    );
    assert.match(output.system[0] ?? "", /Oh My Harness v2/);

    const closedPlugin = module.createOpenCodePlugin(
      createFileOpenCodeRuntimeDependencies({
        env: { OH_MY_HARNESS_STATE_ROOT: join(elsewhere, "absent-state") },
      }),
    );
    const closedHooks = await closedPlugin({
      directory: elsewhere,
      worktree: elsewhere,
      project: {},
      client: {},
      experimental_workspace: { register() {} },
      serverUrl: new URL("http://localhost"),
      $: undefined,
    });
    const closedNames = Object.keys(closedHooks.tool);
    assert.equal(closedNames.includes("workspace_cli_setup"), true);
    assert.equal(closedNames.includes("workspace_cli_status"), true);
    assert.equal(closedNames.some((name) => name.startsWith("omh_")), false);
  } finally {
    process.chdir(originalCwd);
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("U10 receipt-owned payload carries its exact OpenCode runtime dependency", async () => {
  const root = mkdtempSync(join(tmpdir(), "omh-opencode-payload-"));
  try {
    const payload = inspectManagedRuntimePayload(REPOSITORY_ROOT, root);
    materializeManagedRuntimePayload(payload);
    const pluginPath = join(
      payload.activeRoot,
      ".opencode",
      "plugins",
      "oh-my-harness.js",
    );
    assert.equal(
      resolve(resolveOpenCodePackageRoot(pathToFileURL(pluginPath).href)),
      resolve(payload.activeRoot),
    );
    const module = await import(
      `${pathToFileURL(pluginPath).href}?payload=${Date.now()}`
    );
    assert.equal(typeof module.createOpenCodePlugin, "function");
    const reconciler = await import(
      `${
        pathToFileURL(join(payload.activeRoot, "dist", "cli", "main.js")).href
      }?payload=${Date.now()}`
    );
    assert.equal(typeof reconciler.runOmh, "function");
    const status = await reconciler.runOmh(
      ["status", "--root", join(root, "state")],
      {
        cwd: root,
        env: process.env,
        repositoryRoot: payload.activeRoot,
      },
    );
    assert.equal(status.state, "unconfigured");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("U10 OpenCode adapter uses no Claude or Codex runtime module", () => {
  const sources = [
    readFileSync(
      join(REPOSITORY_ROOT, "src", "runtime", "opencode.ts"),
      "utf8",
    ),
    readFileSync(PLUGIN_PATH, "utf8"),
  ].join("\n");
  assert.doesNotMatch(
    sources,
    /(?:from|import\()\s*["'][^"']*runtime\/(?:claude|codex)/,
  );
  assert.match(sources, /invokeReceiptReconciler/);
  assert.match(sources, /mode:\s*"native-post-discovery"/);

  const descriptor = JSON.parse(
    readFileSync(
      join(REPOSITORY_ROOT, "harness", "adapters", "opencode.json"),
      "utf8",
    ),
  ) as {
    native: {
      preModelGate: {
        status: string;
        surfaceId: string;
        sourceRef: { locations: string[] };
      };
    };
  };
  assert.equal(descriptor.native.preModelGate.status, "candidate");
  assert.equal(
    descriptor.native.preModelGate.surfaceId,
    "experimental.chat.system.transform",
  );
  assert.equal(
    descriptor.native.preModelGate.sourceRef.locations.some((location) =>
      location.includes("session/llm/request.ts")
    ),
    true,
  );
});
