import { isAbsolute, win32 } from "node:path";

import {
  CAPABILITY_IDS,
  PACKAGE_IDS,
  SUPPORTED_AGENT_IDS,
} from "../domain/catalog.js";

export interface CliSelectionOptions {
  readonly agents: string[];
  readonly apply: boolean;
  readonly digest: string | undefined;
  readonly json: boolean;
  readonly profile: string;
  readonly root: string | undefined;
  readonly tools: string[];
}

export interface CliCustomProfileInput {
  readonly id: string;
  readonly displayName: string;
  readonly selectedAgents: string[];
  readonly requiredPackages: string[];
  readonly optionalPackages: string[];
  readonly capabilities: string[];
}

export type ParsedOmhArguments =
  | { readonly command: "help"; readonly topic?: string; readonly json: false }
  | { readonly command: "version"; readonly json: false }
  | ({
      readonly command: "setup";
    } & CliSelectionOptions)
  | ({
      readonly command: "agents";
      readonly subcommand: "install" | "status";
    } & CliSelectionOptions)
  | ({
      readonly command: "tools";
      readonly subcommand: "install" | "doctor";
    } & CliSelectionOptions)
  | {
      readonly command: "status";
      readonly json: boolean;
      readonly root: string | undefined;
    }
  | {
      readonly command: "doctor";
      readonly json: boolean;
      readonly root: string | undefined;
    }
  | {
      readonly command: "startup";
      readonly format: "json";
      readonly json: true;
      readonly mode: "managed-prelaunch" | "native-post-discovery";
      readonly receipt: string;
      readonly runtime: string;
    }
  | {
      readonly command: "run";
      readonly json: false;
      readonly receipt: string;
      readonly runtime: string;
      readonly runtimeArgs: readonly string[];
    }
  | {
      readonly command: "profiles";
      readonly subcommand: "list";
      readonly json: boolean;
    }
  | {
      readonly command: "profiles";
      readonly subcommand: "create";
      readonly input: CliCustomProfileInput;
      readonly json: boolean;
    }
  | {
      readonly command: "profiles";
      readonly subcommand: "validate";
      readonly file: string;
      readonly json: boolean;
    }
  | {
      readonly command: "profiles";
      readonly subcommand: "preview";
      readonly file: string;
      readonly repositoryRoot: string;
      readonly json: boolean;
    }
  | {
      readonly command: "profiles";
      readonly subcommand: "publish";
      readonly file: string;
      readonly repositoryRoot: string;
      readonly digest: string;
      readonly json: boolean;
    };

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PROFILE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const AGENT_ALIASES = new Map([
  ["claude", "claude-code"],
  ["claude-code", "claude-code"],
  ["opencode", "opencode"],
  ["codex", "codex"],
]);
const PACKAGE_ALIASES = new Map([
  ["notion", "notion"],
  ["ntn", "notion"],
  ["linear", "linear"],
  ["jira", "jira"],
  ["confluence", "confluence"],
  ["github", "github"],
  ["gh", "github"],
  ["gitlab", "gitlab"],
  ["glab", "gitlab"],
]);

function fail(message: string): never {
  throw new Error(message);
}

function valueAfter(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    fail(`${flag} requires a value`);
  }
  return value;
}

function commaSeparated(
  value: string,
  aliases: ReadonlyMap<string, string>,
  allowed: readonly string[],
  label: string,
): string[] {
  const values = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (values.length === 0) fail(`${label} must not be empty`);
  const resolved = values.map((entry) => aliases.get(entry) ?? entry);
  if (resolved.some((entry) => !allowed.includes(entry))) {
    fail(`${label} must contain ids from: ${allowed.join(", ")}`);
  }
  if (new Set(resolved).size !== resolved.length) {
    fail(`${label} contains duplicate ids or aliases`);
  }
  return resolved;
}

function exactDigest(value: string, label: string): string {
  if (!SHA256_PATTERN.test(value)) {
    fail(`${label} must be an exact lowercase SHA-256`);
  }
  return value;
}

function absolute(value: string, label: string): string {
  if (!isAbsolute(value) && !win32.isAbsolute(value)) {
    fail(`${label} must be absolute`);
  }
  return value;
}

function parseSelection(
  argv: readonly string[],
  input: {
    readonly allowApply: boolean;
    readonly allowAgents: boolean;
    readonly allowTools: boolean;
    readonly defaultAgents?: readonly string[];
    readonly defaultTools?: readonly string[];
  },
): CliSelectionOptions {
  let agents = [...(input.defaultAgents ?? SUPPORTED_AGENT_IDS)];
  let tools = [...(input.defaultTools ?? PACKAGE_IDS)];
  let apply = false;
  let digest: string | undefined;
  let json = false;
  let profile = "personal";
  let root: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--json") {
      json = true;
      continue;
    }
    if (flag === "--apply") {
      if (!input.allowApply) fail("--apply is not valid for this command");
      apply = true;
      continue;
    }
    if (flag === "--digest") {
      if (!input.allowApply) fail("--digest is not valid for this command");
      digest = exactDigest(valueAfter(argv, index, flag), "--digest");
      index += 1;
      continue;
    }
    if (flag === "--profile") {
      profile = valueAfter(argv, index, flag);
      if (!PROFILE_ID_PATTERN.test(profile)) fail("--profile is invalid");
      index += 1;
      continue;
    }
    if (flag === "--root") {
      root = absolute(valueAfter(argv, index, flag), "--root");
      index += 1;
      continue;
    }
    if (flag === "--agents" || (flag === "--only" && input.allowAgents)) {
      if (!input.allowAgents) fail("agent selection is not valid for this command");
      agents = commaSeparated(
        valueAfter(argv, index, flag),
        AGENT_ALIASES,
        SUPPORTED_AGENT_IDS,
        flag,
      );
      index += 1;
      continue;
    }
    if (flag === "--tools" || (flag === "--only" && input.allowTools)) {
      if (!input.allowTools) fail("tool selection is not valid for this command");
      tools = commaSeparated(
        valueAfter(argv, index, flag),
        PACKAGE_ALIASES,
        PACKAGE_IDS,
        flag,
      );
      index += 1;
      continue;
    }
    fail(`unknown option: ${String(flag)}`);
  }
  if (apply && digest === undefined) {
    fail("--apply requires the exact --digest printed by preview");
  }
  if (!apply && digest !== undefined) fail("--digest requires --apply");
  return { agents, apply, digest, json, profile, root, tools };
}

function parseKeyValueOptions(
  argv: readonly string[],
  allowed: readonly string[],
): { readonly values: ReadonlyMap<string, string>; readonly json: boolean } {
  const values = new Map<string, string>();
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--json") {
      json = true;
      continue;
    }
    if (!flag || !allowed.includes(flag)) fail(`unknown option: ${String(flag)}`);
    if (values.has(flag)) fail(`duplicate option: ${flag}`);
    values.set(flag, valueAfter(argv, index, flag));
    index += 1;
  }
  return { json, values };
}

function requiredOption(
  values: ReadonlyMap<string, string>,
  flag: string,
): string {
  const value = values.get(flag);
  if (value === undefined) fail(`${flag} is required`);
  return value;
}

function parseProfiles(argv: readonly string[]): ParsedOmhArguments {
  const subcommand = argv[0];
  const rest = argv.slice(1);
  if (subcommand === undefined || ["help", "--help", "-h"].includes(subcommand)) {
    return { command: "help", topic: "profiles", json: false };
  }
  if (subcommand === "list") {
    if (rest.length === 0) return { command: "profiles", subcommand, json: false };
    if (rest.length === 1 && rest[0] === "--json") {
      return { command: "profiles", subcommand, json: true };
    }
    fail("use `omh profiles list [--json]`");
  }
  if (subcommand === "create") {
    const parsed = parseKeyValueOptions(rest, [
      "--id",
      "--name",
      "--agents",
      "--required",
      "--optional",
      "--capabilities",
    ]);
    const id = requiredOption(parsed.values, "--id");
    if (!PROFILE_ID_PATTERN.test(id)) fail("--id is invalid");
    const input: CliCustomProfileInput = {
      capabilities: commaSeparated(
        requiredOption(parsed.values, "--capabilities"),
        new Map(),
        CAPABILITY_IDS,
        "--capabilities",
      ),
      displayName: requiredOption(parsed.values, "--name"),
      id,
      optionalPackages: parsed.values.has("--optional")
        ? commaSeparated(
            requiredOption(parsed.values, "--optional"),
            PACKAGE_ALIASES,
            PACKAGE_IDS,
            "--optional",
          )
        : [],
      requiredPackages: commaSeparated(
        requiredOption(parsed.values, "--required"),
        PACKAGE_ALIASES,
        PACKAGE_IDS,
        "--required",
      ),
      selectedAgents: commaSeparated(
        requiredOption(parsed.values, "--agents"),
        AGENT_ALIASES,
        SUPPORTED_AGENT_IDS,
        "--agents",
      ),
    };
    return { command: "profiles", input, json: parsed.json, subcommand };
  }
  if (subcommand === "validate") {
    const parsed = parseKeyValueOptions(rest, ["--file"]);
    return {
      command: "profiles",
      file: requiredOption(parsed.values, "--file"),
      json: parsed.json,
      subcommand,
    };
  }
  if (subcommand === "preview" || subcommand === "publish") {
    const parsed = parseKeyValueOptions(
      rest,
      subcommand === "publish"
        ? ["--file", "--repo", "--digest"]
        : ["--file", "--repo"],
    );
    const file = requiredOption(parsed.values, "--file");
    const repositoryRoot = absolute(
      requiredOption(parsed.values, "--repo"),
      "--repo",
    );
    if (subcommand === "preview") {
      return {
        command: "profiles",
        file,
        json: parsed.json,
        repositoryRoot,
        subcommand: "preview",
      };
    }
    return {
      command: "profiles",
      digest: exactDigest(
        requiredOption(parsed.values, "--digest"),
        "--digest",
      ),
      file,
      json: parsed.json,
      repositoryRoot,
      subcommand: "publish",
    };
  }
  fail("profiles requires list, create, validate, preview, or publish");
}

function parseStartup(argv: readonly string[]): ParsedOmhArguments {
  const parsed = parseKeyValueOptions(argv, [
    "--runtime",
    "--mode",
    "--receipt",
    "--format",
  ]);
  const runtime = requiredOption(parsed.values, "--runtime");
  if (!SUPPORTED_AGENT_IDS.includes(runtime as never)) {
    fail(`--runtime must be one of: ${SUPPORTED_AGENT_IDS.join(", ")}`);
  }
  const mode = requiredOption(parsed.values, "--mode");
  if (!["managed-prelaunch", "native-post-discovery"].includes(mode)) {
    fail("--mode is invalid");
  }
  const format = requiredOption(parsed.values, "--format");
  if (format !== "json") fail("--format must be json");
  return {
    command: "startup",
    format,
    json: true,
    mode: mode as "managed-prelaunch" | "native-post-discovery",
    receipt: absolute(
      requiredOption(parsed.values, "--receipt"),
      "--receipt",
    ),
    runtime,
  };
}

function parseRun(argv: readonly string[]): ParsedOmhArguments {
  const separator = argv.indexOf("--");
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const runtimeArgs = separator === -1 ? [] : argv.slice(separator + 1);
  const parsed = parseKeyValueOptions(own, ["--runtime", "--receipt"]);
  const runtime = requiredOption(parsed.values, "--runtime");
  if (!SUPPORTED_AGENT_IDS.includes(runtime as never)) {
    fail(`--runtime must be one of: ${SUPPORTED_AGENT_IDS.join(", ")}`);
  }
  if (parsed.json) fail("run does not support --json");
  return {
    command: "run",
    json: false,
    receipt: absolute(
      requiredOption(parsed.values, "--receipt"),
      "--receipt",
    ),
    runtime,
    runtimeArgs,
  };
}

export function parseOmhArguments(
  argv: readonly string[],
): ParsedOmhArguments {
  if (!Array.isArray(argv)) fail("argv must be an array");
  const command = argv[0];
  if (
    command === undefined
    || ["help", "--help", "-h"].includes(command)
  ) {
    return { command: "help", json: false };
  }
  if (["--version", "-V", "version"].includes(command)) {
    return { command: "version", json: false };
  }
  if (command === "setup") {
    if (["help", "--help", "-h"].includes(argv[1] ?? "")) {
      return { command: "help", topic: "setup", json: false };
    }
    return {
      command,
      ...parseSelection(argv.slice(1), {
        allowAgents: true,
        allowApply: true,
        allowTools: true,
        defaultAgents: ["claude-code"],
      }),
    };
  }
  if (command === "agents") {
    const subcommand = argv[1];
    if (subcommand === undefined || ["help", "--help", "-h"].includes(subcommand)) {
      return { command: "help", topic: "agents", json: false };
    }
    if (!["install", "status"].includes(subcommand)) {
      fail("agents requires install or status");
    }
    if (argv.slice(2).some((value) => ["help", "--help", "-h"].includes(value))) {
      return { command: "help", topic: "agents", json: false };
    }
    return {
      command,
      subcommand: subcommand as "install" | "status",
      ...parseSelection(argv.slice(2), {
        allowAgents: true,
        allowApply: subcommand === "install",
        allowTools: false,
        defaultAgents: SUPPORTED_AGENT_IDS,
        defaultTools: [],
      }),
    };
  }
  if (command === "tools") {
    const subcommand = argv[1];
    if (subcommand === undefined || ["help", "--help", "-h"].includes(subcommand)) {
      return { command: "help", topic: "tools", json: false };
    }
    if (!["install", "doctor"].includes(subcommand)) {
      fail("tools requires install or doctor");
    }
    if (argv.slice(2).some((value) => ["help", "--help", "-h"].includes(value))) {
      return { command: "help", topic: "tools", json: false };
    }
    return {
      command,
      subcommand: subcommand as "install" | "doctor",
      ...parseSelection(argv.slice(2), {
        allowAgents: false,
        allowApply: subcommand === "install",
        allowTools: true,
        defaultAgents: ["claude-code"],
      }),
    };
  }
  if (command === "status" || command === "doctor") {
    if (["help", "--help", "-h"].includes(argv[1] ?? "")) {
      return { command: "help", topic: command, json: false };
    }
    if (argv.slice(1).includes("--apply")) {
      fail("--apply is not valid for this command");
    }
    const parsed = parseKeyValueOptions(argv.slice(1), ["--root"]);
    return {
      command,
      json: parsed.json,
      root: parsed.values.has("--root")
        ? absolute(requiredOption(parsed.values, "--root"), "--root")
        : undefined,
    };
  }
  if (command === "profiles") return parseProfiles(argv.slice(1));
  if (command === "startup") return parseStartup(argv.slice(1));
  if (command === "run") return parseRun(argv.slice(1));
  fail(`unknown command: ${command}`);
}
