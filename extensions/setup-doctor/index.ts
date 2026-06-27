import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const QUOTIO_REQUIRED_ENV_VARS = ["QUOTIO_BASE_URL", "QUOTIO_API_KEY"] as const;
const COMMAND_TIMEOUT_MS = 3000;
const QUOTIO_TIMEOUT_MS = 5000;

type Status = "ok" | "warn" | "error" | "info";

interface CommandResult {
  available: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

function statusIcon(status: Status): string {
  switch (status) {
    case "ok":
      return "✅";
    case "warn":
      return "⚠️";
    case "error":
      return "❌";
    case "info":
      return "ℹ️";
  }
}

function line(status: Status, label: string, detail: string): string {
  return `${statusIcon(status)} ${label}: ${detail}`;
}

function isSet(key: string): boolean {
  const value = process.env[key]?.trim();
  return value !== undefined && value !== "";
}

function describeToggle(key: "ENABLE_QUOTIO" | "ENABLE_WORKSPACE_CONNECTORS"): string {
  const value = process.env[key];
  if (value === "true") return "enabled (true)";
  if (value === undefined || value.trim() === "") return "disabled (unset)";
  return `disabled (${value}; expected true)`;
}

function envPresenceLine(key: string): string {
  return `${key}=${isSet(key) ? "set" : "missing"}`;
}

function localOnlyPathStatus(path: string): string {
  return `${path} (${existsSync(path) ? "present" : "not present"})`;
}

function summarizeCommandOutput(output: string): string {
  const cleaned = output
    .replace(/github_pat_[A-Za-z0-9_]+/g, "github_pat_…")
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "gh*_…")
    .split("\n")
    .map((part) => part.trim())
    .filter(Boolean);

  return cleaned.slice(0, 2).join("; ");
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, { shell: process.platform === "win32" });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    const finish = (result: Omit<CommandResult, "stdout" | "stderr" | "timedOut">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({ ...result, stdout, stderr, timedOut });
    };

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({ available: false, code: null, error: error.code ?? error.message });
    });
    child.on("exit", (code) => {
      finish({ available: true, code });
    });
  });
}

async function checkGhAuth(): Promise<string> {
  const result = await runCommand("gh", ["auth", "status", "--hostname", "github.com"], COMMAND_TIMEOUT_MS);

  if (!result.available) {
    return line("warn", "GitHub CLI auth", `gh not available (${result.error ?? "spawn failed"})`);
  }

  if (result.timedOut) {
    return line("warn", "GitHub CLI auth", `timed out after ${COMMAND_TIMEOUT_MS}ms`);
  }

  const summary = summarizeCommandOutput(`${result.stdout}\n${result.stderr}`);
  if (result.code === 0) {
    return line("ok", "GitHub CLI auth", summary || "authenticated");
  }

  return line(
    "warn",
    "GitHub CLI auth",
    summary || `not authenticated or unavailable (exit ${result.code}); run gh auth login if needed`,
  );
}

async function checkQuotioConnectivity(): Promise<string> {
  if (process.env.ENABLE_QUOTIO !== "true") {
    return line("info", "Quotio connectivity", "skipped because ENABLE_QUOTIO is not true");
  }

  const missing = QUOTIO_REQUIRED_ENV_VARS.filter((key) => !isSet(key));
  if (missing.length > 0) {
    return line("warn", "Quotio connectivity", `skipped because missing ${missing.join(", ")}`);
  }

  const baseUrl = process.env.QUOTIO_BASE_URL!.trim().replace(/\/+$/, "");
  const apiKey = process.env.QUOTIO_API_KEY!.trim();
  const startTime = Date.now();

  try {
    const response = await fetch(`${baseUrl}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(QUOTIO_TIMEOUT_MS),
    });
    const elapsed = Date.now() - startTime;

    if (!response.ok) {
      const authHint = response.status === 401 || response.status === 403 ? " (check QUOTIO_API_KEY)" : "";
      return line("warn", "Quotio connectivity", `HTTP ${response.status} after ${elapsed}ms${authHint}`);
    }

    const data = (await response.json().catch(() => undefined)) as { data?: unknown[] } | undefined;
    const modelCount = Array.isArray(data?.data) ? data.data.length : "unknown";
    return line("ok", "Quotio connectivity", `connected in ${elapsed}ms; models=${modelCount}`);
  } catch (error: any) {
    const elapsed = Date.now() - startTime;
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      return line("warn", "Quotio connectivity", `timed out after ${elapsed}ms`);
    }
    return line("warn", "Quotio connectivity", `failed after ${elapsed}ms — ${error?.message ?? String(error)}`);
  }
}

async function buildDoctorReport(): Promise<string> {
  const cwd = process.cwd();
  const envPath = resolve(cwd, ".env");
  const quotioEnvSummary = QUOTIO_REQUIRED_ENV_VARS.map(envPresenceLine).join(", ");
  const localOnlyPaths = [
    resolve(cwd, ".env"),
    resolve(cwd, ".mcp-auth"),
    resolve(cwd, "auth.json"),
    resolve(cwd, "sessions"),
    resolve(homedir(), ".pi", "agent", "auth.json"),
    resolve(homedir(), ".pi", "agent", "sessions"),
  ];

  const [quotioConnectivity, ghAuth] = await Promise.all([
    checkQuotioConnectivity(),
    checkGhAuth(),
  ]);

  return [
    "oh-my-pi setup doctor",
    "",
    line(existsSync(envPath) ? "ok" : "warn", "CWD .env", existsSync(envPath) ? `found at ${envPath}` : `not found at ${envPath}`),
    line(process.env.ENABLE_QUOTIO === "true" ? "ok" : "info", "ENABLE_QUOTIO", describeToggle("ENABLE_QUOTIO")),
    line(process.env.ENABLE_WORKSPACE_CONNECTORS === "true" ? "ok" : "info", "ENABLE_WORKSPACE_CONNECTORS", describeToggle("ENABLE_WORKSPACE_CONNECTORS")),
    line(QUOTIO_REQUIRED_ENV_VARS.every((key) => isSet(key)) ? "ok" : "warn", "Quotio env", quotioEnvSummary),
    quotioConnectivity,
    ghAuth,
    line("info", "Local-only reminders", localOnlyPaths.map(localOnlyPathStatus).join("; ")),
    "",
    "Keep local-only files out of commits: .env, .mcp-auth, auth.json, sessions/, ~/.pi/agent/auth.json, ~/.pi/agent/sessions/.",
  ].join("\n");
}

function buildPaletteReport(): string {
  return [
    "oh-my-pi commands",
    "",
    "- /oh-my-pi-doctor — run read-only setup diagnostics for local env, Quotio, gh auth, and local-only paths.",
    "- /oh-my-pi — show this lightweight command palette.",
    "- /quotio-status — check Quotio models when ENABLE_QUOTIO=true and Quotio env is configured.",
    "- /connector-login linear|notion — start workspace connector OAuth when ENABLE_WORKSPACE_CONNECTORS=true.",
    "- /connector-tools linear|notion — list connector tools after login.",
    "",
    "Tip: CWD .env is loaded by env-loader before other oh-my-pi extensions.",
  ].join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("oh-my-pi-doctor", {
    description: "Run read-only oh-my-pi setup diagnostics for env toggles, Quotio, gh auth, and local-only paths.",
    handler: async (_args, ctx) => {
      ctx.ui.notify(await buildDoctorReport(), "info");
    },
  });

  pi.registerCommand("oh-my-pi", {
    description: "Show the lightweight oh-my-pi command palette and setup help.",
    handler: async (_args, ctx) => {
      ctx.ui.notify(buildPaletteReport(), "info");
    },
  });
}
