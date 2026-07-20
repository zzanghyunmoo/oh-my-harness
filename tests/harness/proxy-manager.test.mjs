import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_PROXY_INSTALL_IDS,
  PROXY_IDS,
  PROXY_PROFILE_MANIFEST,
  applyProxyConfigurationPlan,
  applyProxyInstallPlan,
  buildProxyConfigurationPlan,
  buildProxyInstallPlan,
  inspectProxyConnections,
  parseProxyArguments,
} from "../../scripts/proxies/manage.mjs";

test("proxy manifest declares all profiles and installs only Quotio and CCS by default", () => {
  assert.deepEqual(PROXY_IDS, ["litellm", "quotio", "ccs"]);
  assert.deepEqual(DEFAULT_PROXY_INSTALL_IDS, ["quotio", "ccs"]);
  const quotio = PROXY_PROFILE_MANIFEST.profiles.find(({ id }) => id === "quotio");
  const ccs = PROXY_PROFILE_MANIFEST.profiles.find(({ id }) => id === "ccs");
  assert.equal(quotio.install.version, "0.24.0");
  assert.match(quotio.install.archive.sha256, /^[a-f0-9]{64}$/);
  assert.match(quotio.install.executableSha256, /^[a-f0-9]{64}$/);
  assert.equal(ccs.install.package, "@kaitranntt/ccs");
  assert.equal(ccs.install.version, "8.8.1");
  assert.match(ccs.install.integrity, /^sha512-/);
});

test("proxy installation is preview-first and keeps unsupported Quotio non-fatal on Windows", () => {
  const root = join(tmpdir(), "omh-proxy-preview-does-not-exist");
  const windows = buildProxyInstallPlan({ installRoot: root, platform: "win32", arch: "x64", env: { PATH: "" } });
  assert.equal(windows[0].id, "quotio");
  assert.equal(windows[0].status, "unsupported");
  assert.match(windows[0].guidance, /macOS 15\+ on Apple Silicon/);
  assert.equal(windows[1].id, "ccs");
  assert.equal(windows[1].status, "manager-missing");
  assert.deepEqual(windows[1].installer.args, ["install", "--global", "--no-audit", "--no-fund", "@kaitranntt/ccs@8.8.1"]);
  assert.equal(existsSync(root), false);

  const mac = buildProxyInstallPlan({ installRoot: root, platform: "darwin", arch: "arm64", env: { PATH: "" } });
  assert.equal(mac[0].status, "installable");
  assert.equal(mac[0].installer.expectedArchiveSha256, PROXY_PROFILE_MANIFEST.profiles[1].install.archive.sha256);
});

test("CCS planning detects exact installed version drift", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "omh-proxy-ccs-version-"));
  const bin = join(root, "bin");
  const workspace = join(root, "workspace");
  mkdirSync(bin);
  mkdirSync(workspace);
  const executable = join(bin, "ccs");
  try {
    writeFileSync(executable, "#!/bin/sh\nprintf 'ccs/8.7.0 test-platform\\n'\n", { mode: 0o700 });
    chmodSync(executable, 0o700);
    const mismatched = buildProxyInstallPlan({ installRoot: join(root, "managed"), env: { ...process.env, PATH: bin }, proxyIds: ["ccs"], workspace });
    assert.equal(mismatched[0].status, "version-mismatch");
    assert.equal(mismatched[0].installedVersion, "8.7.0");

    writeFileSync(executable, "#!/bin/sh\nprintf 'ccs/8.8.1 test-platform\\n'\n", { mode: 0o700 });
    const exact = buildProxyInstallPlan({ installRoot: join(root, "managed"), env: { ...process.env, PATH: bin }, proxyIds: ["ccs"], workspace });
    assert.equal(exact[0].status, "installed");
    assert.equal(exact[0].installedVersion, "8.8.1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("proxy install apply can materialize the reviewed app plan without touching unsupported rows", async () => {
  const calls = [];
  const plan = [
    { id: "quotio", label: "Quotio", status: "installable", installer: { kind: "verified-macos-app" } },
    { id: "litellm", label: "LiteLLM", status: "external", installer: { kind: "external" } },
  ];
  const result = await applyProxyInstallPlan(plan, {
    installRoot: "/tmp/omh-proxy-managed",
    installMacApp: async (profile, root) => {
      calls.push([profile.id, root]);
      return "/tmp/omh-proxy-managed/apps/quotio/0.24.0/Quotio.app";
    },
  });
  assert.deepEqual(calls, [["quotio", "/tmp/omh-proxy-managed"]]);
  assert.equal(result[0].status, "installed");
  assert.equal(result[0].applied, true);
  assert.equal(result[1].applied, false);
});

test("CCS apply verifies the reviewed npm integrity before installation", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "omh-proxy-ccs-integrity-"));
  const bin = join(root, "bin");
  const workspace = join(root, "workspace");
  const installRoot = join(root, "managed");
  mkdirSync(bin);
  mkdirSync(workspace);
  const npm = join(bin, "npm");
  const ccs = join(bin, "ccs");
  writeFileSync(npm, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  chmodSync(npm, 0o700);
  const env = { PATH: bin };
  const plan = buildProxyInstallPlan({ installRoot, env, proxyIds: ["ccs"], workspace });
  assert.equal(plan[0].status, "installable");
  const calls = [];
  try {
    await assert.rejects(
      applyProxyInstallPlan(plan, {
        installRoot,
        env,
        workspace,
        run: (_command, args) => {
          calls.push(args);
          return JSON.stringify("sha512-not-the-reviewed-package");
        },
      }),
      /integrity does not match/,
    );
    assert.equal(calls.some((args) => args[0] === "install"), false);

    calls.length = 0;
    const result = await applyProxyInstallPlan(plan, {
      installRoot,
      env,
      workspace,
      run: (_command, args) => {
        calls.push(args);
        if (args[0] === "view") return JSON.stringify(PROXY_PROFILE_MANIFEST.profiles[2].install.integrity);
        if (args[0] === "install") {
          writeFileSync(ccs, "#!/bin/sh\nprintf 'ccs/8.8.1 test-platform\\n'\n", { mode: 0o700 });
          chmodSync(ccs, 0o700);
          return "";
        }
        if (args.at(-1) === "--version") return "ccs/8.8.1 test-platform\n";
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
    });
    assert.equal(result[0].status, "installed");
    assert.deepEqual(calls.slice(0, 2).map((args) => args[0]), ["view", "install"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("proxy configuration persists endpoint and key from environment without exposing values in results", () => {
  const cwd = mkdtempSync(join(tmpdir(), "omh-proxy-config-"));
  const secret = "sk-test-never-print";
  try {
    const env = {
      LITELLM_BASE_URL: "http://localhost:4000/v1",
      LITELLM_API_KEY: secret,
    };
    const preview = buildProxyConfigurationPlan({ cwd, env, proxyIds: ["litellm"] });
    assert.equal(preview[0].status, "ready-to-apply");
    assert.equal(existsSync(join(cwd, ".env")), false);
    assert.doesNotMatch(JSON.stringify(preview), new RegExp(secret));

    const applied = applyProxyConfigurationPlan(preview, { cwd, env });
    assert.equal(applied[0].status, "configured");
    assert.equal(applied[0].applied, true);
    assert.doesNotMatch(JSON.stringify(applied), new RegExp(secret));
    const content = readFileSync(join(cwd, ".env"), "utf8");
    assert.match(content, /ENABLE_LITELLM=true/);
    assert.match(content, /LITELLM_BASE_URL=http:\/\/localhost:4000\/v1/);
    assert.match(content, /LITELLM_API_KEY=sk-test-never-print/);
    if (process.platform !== "win32") assert.equal(lstatSync(join(cwd, ".env")).mode & 0o777, 0o600);

    const second = buildProxyConfigurationPlan({
      cwd,
      env: { CCS_BASE_URL: "http://localhost:8318/v1", CCS_API_KEY: "sk-ccs-test" },
      proxyIds: ["ccs"],
    });
    assert.equal(applyProxyConfigurationPlan(second, {
      cwd,
      env: { CCS_BASE_URL: "http://localhost:8318/v1", CCS_API_KEY: "sk-ccs-test" },
    })[0].applied, true);
    assert.match(readFileSync(join(cwd, ".env"), "utf8"), /CCS_BASE_URL=http:\/\/localhost:8318\/v1/);

    const repeated = buildProxyConfigurationPlan({ cwd, env: {}, proxyIds: ["litellm"] });
    assert.equal(repeated[0].status, "configured");
    assert.equal(applyProxyConfigurationPlan(repeated, { cwd, env: {} })[0].applied, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("proxy configuration waits for both values and refuses unsafe dotenv values", () => {
  const cwd = mkdtempSync(join(tmpdir(), "omh-proxy-invalid-"));
  try {
    const waiting = buildProxyConfigurationPlan({ cwd, env: { CCS_BASE_URL: "http://localhost:8317/v1" }, proxyIds: ["ccs"] });
    assert.deepEqual(waiting[0].missing, ["CCS_API_KEY"]);
    assert.equal(applyProxyConfigurationPlan(waiting, { cwd, env: { CCS_BASE_URL: "http://localhost:8317/v1" } })[0].applied, false);
    assert.equal(existsSync(join(cwd, ".env")), false);

    const ready = buildProxyConfigurationPlan({ cwd, env: { CCS_BASE_URL: "http://localhost:8317/v1", CCS_API_KEY: "bad key" }, proxyIds: ["ccs"] });
    assert.throws(() => applyProxyConfigurationPlan(ready, { cwd, env: { CCS_BASE_URL: "http://localhost:8317/v1", CCS_API_KEY: "bad key" } }), /cannot be stored safely/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("proxy doctor authenticates model discovery but never returns the credential", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "omh-proxy-doctor-"));
  const secret = "sk-doctor-secret";
  try {
    const preview = buildProxyConfigurationPlan({ cwd, env: { QUOTIO_BASE_URL: "http://localhost:8317/v1", QUOTIO_API_KEY: secret }, proxyIds: ["quotio"] });
    applyProxyConfigurationPlan(preview, { cwd, env: { QUOTIO_BASE_URL: "http://localhost:8317/v1", QUOTIO_API_KEY: secret } });
    const calls = [];
    const result = await inspectProxyConnections({
      cwd,
      env: {},
      proxyIds: ["quotio"],
      fetchImpl: async (url, options) => {
        calls.push([url, options.headers.Authorization]);
        return new Response(JSON.stringify({ data: [{ id: "model-a" }] }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    assert.deepEqual(calls, [["http://localhost:8317/v1/models", `Bearer ${secret}`]]);
    assert.deepEqual(result, [{ id: "quotio", label: "Quotio", status: "connected", modelCount: 1, elapsedMs: result[0].elapsedMs }]);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("proxy CLI parsing separates install, configure, and read-only doctor", () => {
  assert.deepEqual(parseProxyArguments(["install"]).proxyIds, ["quotio", "ccs"]);
  assert.deepEqual(parseProxyArguments(["configure", "--only", "litellm,ccs", "--apply"]).proxyIds, ["litellm", "ccs"]);
  assert.throws(() => parseProxyArguments(["doctor", "--apply"]), /read-only/);
  assert.throws(() => parseProxyArguments(["install", "--only", "unknown"]), /unique ids/);
});
