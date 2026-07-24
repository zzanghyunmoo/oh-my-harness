export interface CliArgumentCatalog {
  readonly proxyIds: readonly string[];
  readonly proxyInstallIds: readonly string[];
  readonly runtimeIds: readonly string[];
  readonly toolIds: readonly string[];
  toolIdsForRuntimes(runtimeIds: readonly string[]): readonly string[];
}

export interface CliSelectionOptions {
  readonly agents: string[];
  readonly apply: boolean;
  readonly digest: string | undefined;
  readonly json: boolean;
  readonly profile: string;
  readonly proxies: string[];
  readonly register: boolean;
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
      readonly command: "setup" | "status" | "doctor";
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
      readonly command: "proxies";
      readonly subcommand: "install" | "configure" | "doctor";
      readonly apply: boolean;
      readonly json: boolean;
      readonly proxies: string[];
      readonly root: string | undefined;
    }
  | {
      readonly command: "profiles";
      readonly subcommand: "verify" | "apply";
      readonly profile?: string;
      readonly json: false;
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
      readonly json: boolean;
      readonly repositoryRoot: string;
    }
  | {
      readonly command: "profiles";
      readonly subcommand: "publish";
      readonly digest: string;
      readonly file: string;
      readonly json: boolean;
      readonly repositoryRoot: string;
    };

type SelectionContext = "setup" | "status" | "doctor" | "agents" | "tools";

interface InternalSelectionOptions extends CliSelectionOptions {
  readonly agentsExplicit: boolean;
  readonly proxiesExplicit: boolean;
  readonly toolsExplicit: boolean;
}

interface AllowedOptions {
  readonly allowAgents?: boolean;
  readonly allowApply?: boolean;
  readonly allowDigest?: boolean;
  readonly allowProfile?: boolean;
  readonly allowProxies?: boolean;
  readonly allowRegister?: boolean;
  readonly allowRoot?: boolean;
  readonly allowTools?: boolean;
}

function fail(message: string): never {
  throw new Error(message);
}

function readValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    fail(`${flag} requires a comma-separated value`);
  }
  return value;
}

function aliases(
  ids: readonly string[],
  friendly: ReadonlyArray<readonly [string, string]>,
): ReadonlyMap<string, string> {
  const knownIds = new Set(ids);
  return new Map([
    ...ids.map((id) => [id, id] as const),
    ...friendly.filter(([, id]) => knownIds.has(id)),
  ]);
}

function selection(
  value: string,
  knownAliases: ReadonlyMap<string, string>,
  label: string,
): string[] {
  const values = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const resolved: string[] = [];

  for (const entry of values) {
    const id = knownAliases.get(entry);
    if (id === undefined) {
      fail(`${label} must contain ids from: ${[...new Set(knownAliases.values())].join(", ")}`);
    }
    resolved.push(id);
  }
  if (resolved.length === 0) {
    fail(`${label} must contain ids from: ${[...new Set(knownAliases.values())].join(", ")}`);
  }
  if (new Set(resolved).size !== resolved.length) {
    fail(`${label} must not contain duplicate ids or aliases`);
  }
  return resolved;
}

function parseOptions(
  argv: readonly string[],
  context: SelectionContext,
  catalog: CliArgumentCatalog,
  agentAliases: ReadonlyMap<string, string>,
  toolAliases: ReadonlyMap<string, string>,
  proxyAliases: ReadonlyMap<string, string>,
): InternalSelectionOptions {
  let agents = [...catalog.runtimeIds];
  let agentsExplicit = false;
  let apply = false;
  let digest: string | undefined;
  let json = false;
  let profile = "personal";
  let proxies = [...catalog.proxyIds];
  let proxiesExplicit = false;
  let register = true;
  let root: string | undefined;
  let tools = [...catalog.toolIds];
  let toolsExplicit = false;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--apply") apply = true;
    else if (value === "--digest") {
      digest = readValue(argv, index, value);
      index += 1;
    } else if (value === "--profile") {
      profile = readValue(argv, index, value);
      index += 1;
    }
    else if (value === "--json") json = true;
    else if (value === "--skip-registration") register = false;
    else if (value === "--root") {
      root = readValue(argv, index, value);
      index += 1;
    } else if (value !== undefined && ["--agents", "--agent", "--runtime"].includes(value)) {
      agents = selection(readValue(argv, index, value), agentAliases, value);
      agentsExplicit = true;
      index += 1;
    } else if (value !== undefined && ["--tools", "--tool"].includes(value)) {
      tools = selection(readValue(argv, index, value), toolAliases, value);
      toolsExplicit = true;
      index += 1;
    } else if (value !== undefined && ["--proxies", "--proxy"].includes(value)) {
      proxies = selection(readValue(argv, index, value), proxyAliases, value);
      proxiesExplicit = true;
      index += 1;
    } else if (value === "--only") {
      const raw = readValue(argv, index, value);
      if (context === "agents") {
        agents = selection(raw, agentAliases, value);
        agentsExplicit = true;
      } else if (context === "tools") {
        tools = selection(raw, toolAliases, value);
        toolsExplicit = true;
      } else {
        fail("--only is valid only after `omh agents`, `omh tools`, or `omh proxies`");
      }
      index += 1;
    } else {
      fail(`unknown ${context} option: ${String(value)}`);
    }
  }

  if (!toolsExplicit && ["setup", "status", "doctor"].includes(context)) {
    tools = [...catalog.toolIdsForRuntimes(agents)];
  } else if (!toolsExplicit && context === "tools") {
    tools = [...catalog.toolIdsForRuntimes(catalog.runtimeIds)];
  }

  return {
    agents,
    agentsExplicit,
    apply,
    digest,
    json,
    profile,
    proxies,
    proxiesExplicit,
    register,
    root,
    tools,
    toolsExplicit,
  };
}

function rejectOptions(
  options: InternalSelectionOptions,
  {
    allowAgents = false,
    allowApply = false,
    allowDigest = false,
    allowProfile = false,
    allowProxies = false,
    allowRegister = false,
    allowRoot = false,
    allowTools = false,
  }: AllowedOptions = {},
): void {
  if (!allowApply && options.apply) fail("--apply is not valid for this command");
  if (!allowDigest && options.digest !== undefined) fail("--digest is not valid for this command");
  if (!allowProfile && options.profile !== "personal") fail("--profile is not valid for this command");
  if (!allowRegister && !options.register) fail("--skip-registration is not valid for this command");
  if (!allowRoot && options.root !== undefined) fail("--root is not valid for this command");
  if (!allowAgents && options.agentsExplicit) fail("agent selection is not valid for this command");
  if (!allowProxies && options.proxiesExplicit) fail("proxy selection is not valid for this command");
  if (!allowTools && options.toolsExplicit) fail("tool selection is not valid for this command");
  if (!options.apply && !options.register) fail("--skip-registration requires --apply");
  if (options.apply && options.digest === undefined) {
    fail("--apply requires the exact --digest printed by preview");
  }
  if (!options.apply && options.digest !== undefined) {
    fail("--digest requires --apply");
  }
  if (options.digest !== undefined && !/^[0-9a-f]{64}$/.test(options.digest)) {
    fail("--digest must be an exact lowercase SHA-256");
  }
}

function publicOptions(options: InternalSelectionOptions): CliSelectionOptions {
  return {
    agents: options.agents,
    apply: options.apply,
    digest: options.digest,
    json: options.json,
    profile: options.profile,
    proxies: options.proxies,
    register: options.register,
    root: options.root,
    tools: options.tools,
  };
}

function commaSeparated(value: string): string[] {
  const values = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (new Set(values).size !== values.length) {
    fail("profile lists must not contain duplicate IDs");
  }
  return values;
}

function parseProfileArguments(argv: readonly string[]): ParsedOmhArguments {
  const subcommand = argv[0];
  const rest = argv.slice(1);
  if (subcommand === undefined || ["--help", "-h", "help"].includes(subcommand)) {
    return { command: "help", topic: "profiles", json: false };
  }
  if (subcommand === "list") {
    if (rest.length === 0) return { command: "profiles", subcommand, json: false };
    if (rest.length === 1 && rest[0] === "--json") {
      return { command: "profiles", subcommand, json: true };
    }
    fail("use `omh profiles list [--json]`");
  }
  if (subcommand === "verify" && rest.length === 0) {
    return { command: "profiles", subcommand, json: false };
  }
  if (subcommand === "apply") {
    if (rest.length === 0) {
      return { command: "profiles", subcommand, profile: "default", json: false };
    }
    if (
      rest.length === 2
      && rest[0] === "--profile"
      && rest[1] !== undefined
      && rest[1].length > 0
    ) {
      return { command: "profiles", subcommand, profile: rest[1], json: false };
    }
    fail("use `omh profiles apply [--profile id]`");
  }

  let json = false;
  let file: string | undefined;
  let repositoryRoot: string | undefined;
  let digest: string | undefined;
  const fields = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === "--json") {
      json = true;
      continue;
    }
    if (flag === undefined || ![
      "--id",
      "--name",
      "--agents",
      "--required",
      "--optional",
      "--capabilities",
      "--file",
      "--repo",
      "--digest",
    ].includes(flag)) {
      fail(`unknown profiles ${subcommand} option: ${String(flag)}`);
    }
    const value = readValue(rest, index, flag);
    if (fields.has(flag)) fail(`${flag} must be specified once`);
    fields.set(flag, value);
    index += 1;
  }
  file = fields.get("--file");
  repositoryRoot = fields.get("--repo");
  digest = fields.get("--digest");

  if (subcommand === "create") {
    const requiredFlags = [
      "--id",
      "--name",
      "--agents",
      "--required",
      "--capabilities",
    ] as const;
    for (const flag of requiredFlags) {
      if (!fields.has(flag)) fail(`profiles create requires ${flag}`);
    }
    if (file !== undefined || repositoryRoot !== undefined || digest !== undefined) {
      fail("profiles create accepts catalog IDs only; use preview/publish for repository paths");
    }
    return {
      command: "profiles",
      subcommand,
      input: {
        id: String(fields.get("--id")),
        displayName: String(fields.get("--name")),
        selectedAgents: commaSeparated(String(fields.get("--agents"))),
        requiredPackages: commaSeparated(String(fields.get("--required"))),
        optionalPackages: commaSeparated(fields.get("--optional") ?? ""),
        capabilities: commaSeparated(String(fields.get("--capabilities"))),
      },
      json,
    };
  }
  if (subcommand === "validate") {
    if (file === undefined || repositoryRoot !== undefined || digest !== undefined) {
      fail("use `omh profiles validate --file path [--json]`");
    }
    return { command: "profiles", subcommand, file, json };
  }
  if (subcommand === "preview") {
    if (file === undefined || repositoryRoot === undefined || digest !== undefined) {
      fail("use `omh profiles preview --file path --repo path [--json]`");
    }
    return { command: "profiles", subcommand, file, repositoryRoot, json };
  }
  if (subcommand === "publish") {
    if (
      file === undefined
      || repositoryRoot === undefined
      || digest === undefined
      || !/^[0-9a-f]{64}$/.test(digest)
    ) {
      fail("use `omh profiles publish --file path --repo path --digest sha256 [--json]`");
    }
    return {
      command: "profiles",
      subcommand,
      file,
      repositoryRoot,
      digest,
      json,
    };
  }
  fail("profiles requires list, create, validate, preview, or publish");
}

function parseProxyArguments(
  argv: readonly string[],
  catalog: CliArgumentCatalog,
  proxyAliases: ReadonlyMap<string, string>,
): ParsedOmhArguments {
  const subcommand = argv[0];
  if (subcommand === undefined || ["help", "--help", "-h"].includes(subcommand)) {
    return { command: "help", topic: "proxies", json: false };
  }
  if (!["install", "configure", "doctor"].includes(subcommand)) {
    fail("proxies requires `install`, `configure`, or `doctor`");
  }

  let apply = false;
  let json = false;
  let proxies = [
    ...(subcommand === "install" ? catalog.proxyInstallIds : catalog.proxyIds),
  ];
  let root: string | undefined;

  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--apply") apply = true;
    else if (value === "--json") json = true;
    else if (value === "--only") {
      proxies = selection(readValue(argv, index, value), proxyAliases, value);
      index += 1;
    } else if (value === "--root") {
      root = readValue(argv, index, value);
      index += 1;
    } else {
      fail(`unknown proxy option: ${String(value)}`);
    }
  }

  if (subcommand === "doctor" && apply) {
    fail("proxy doctor is read-only and cannot use --apply");
  }
  if (subcommand !== "install" && root !== undefined) {
    fail("--root is valid only for proxy install");
  }

  return {
    command: "proxies",
    subcommand: subcommand as "install" | "configure" | "doctor",
    apply,
    json,
    proxies,
    root,
  };
}

export function createArgumentParser(
  catalog: CliArgumentCatalog,
): (argv: readonly string[]) => ParsedOmhArguments {
  const agentAliases = aliases(catalog.runtimeIds, [
    ["claude", "claude-code"],
    ["claude-code", "claude-code"],
  ]);
  const toolAliases = aliases(catalog.toolIds, [
    ["jira-cli", "jira"],
    ["linear-cli", "linear"],
    ["gh", "github"],
    ["glab", "gitlab"],
    ["confluence-cli", "confluence"],
    ["ntn", "notion"],
    ["cr", "coderabbit"],
    ["coderabbit-cli", "coderabbit"],
  ]);
  const proxyAliases = aliases(catalog.proxyIds, []);

  return (argv: readonly string[]): ParsedOmhArguments => {
    if (!Array.isArray(argv)) fail("argv must be an array");
    if (argv.length === 0 || ["help", "--help", "-h"].includes(argv[0] ?? "")) {
      return { command: "help", json: false };
    }
    if (["--version", "-V"].includes(argv[0] ?? "")) {
      return { command: "version", json: false };
    }

    const command = argv[0];
    const subcommand = argv[1];
    const rest = argv.slice(2);

    if (command === "setup") {
      if (subcommand !== undefined && ["--help", "-h", "help"].includes(subcommand)) {
        return { command: "help", topic: "setup", json: false };
      }
      const options = parseOptions(argv.slice(1), "setup", catalog, agentAliases, toolAliases, proxyAliases);
      rejectOptions(options, {
        allowAgents: true,
        allowApply: true,
        allowDigest: true,
        allowProfile: true,
        allowProxies: true,
        allowRegister: true,
        allowRoot: true,
        allowTools: true,
      });
      return { command, ...publicOptions(options) };
    }
    if (command === "agents") {
      if (subcommand === undefined || ["--help", "-h", "help"].includes(subcommand)) {
        return { command: "help", topic: "agents", json: false };
      }
      if (!["install", "status"].includes(subcommand)) {
        fail("omh agents requires `install` or `status`");
      }
      if (rest.some((entry) => ["--help", "-h", "help"].includes(entry))) {
        return { command: "help", topic: "agents", json: false };
      }
      const options = parseOptions(rest, "agents", catalog, agentAliases, toolAliases, proxyAliases);
      rejectOptions(options, {
        allowAgents: true,
        allowApply: subcommand === "install",
        allowDigest: subcommand === "install",
        allowProfile: true,
        allowRegister: subcommand === "install",
        allowRoot: true,
      });
      return {
        command,
        subcommand: subcommand as "install" | "status",
        ...publicOptions(options),
      };
    }
    if (command === "tools") {
      if (subcommand === undefined || ["--help", "-h", "help"].includes(subcommand)) {
        return { command: "help", topic: "tools", json: false };
      }
      if (!["install", "doctor"].includes(subcommand)) {
        fail("omh tools requires `install` or `doctor`");
      }
      if (rest.some((entry) => ["--help", "-h", "help"].includes(entry))) {
        return { command: "help", topic: "tools", json: false };
      }
      const options = parseOptions(rest, "tools", catalog, agentAliases, toolAliases, proxyAliases);
      rejectOptions(options, {
        allowApply: subcommand === "install",
        allowDigest: subcommand === "install",
        allowProfile: true,
        allowTools: true,
      });
      return {
        command,
        subcommand: subcommand as "install" | "doctor",
        ...publicOptions(options),
      };
    }
    if (command === "proxies") {
      return parseProxyArguments(argv.slice(1), catalog, proxyAliases);
    }
    if (command === "status" || command === "doctor") {
      if (subcommand !== undefined && ["--help", "-h", "help"].includes(subcommand)) {
        return { command: "help", topic: command, json: false };
      }
      const options = parseOptions(argv.slice(1), command, catalog, agentAliases, toolAliases, proxyAliases);
      rejectOptions(options, {
        allowAgents: true,
        allowProfile: true,
        allowProxies: true,
        allowRoot: true,
        allowTools: true,
      });
      return { command, ...publicOptions(options) };
    }
    if (command === "profiles") {
      return parseProfileArguments(argv.slice(1));
    }
    fail(`unknown command: ${String(command)}`);
  };
}
