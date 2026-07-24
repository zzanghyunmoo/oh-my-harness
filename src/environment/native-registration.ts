import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  applyEdits,
  modify,
  parse as parseJsonc,
} from "jsonc-parser";

import {
  gitTreeSha1,
  type VerifiedOfficialPlugin,
} from "../install/official-marketplace.js";
import { hashManagedDirectory } from "../install/managed-payload.js";
import {
  atomicWriteFile,
  readBoundedRegularFile,
} from "./filesystem.js";

export type NativeCommandRunner = (
  command: string,
  args: readonly string[],
) => string;

export interface ManagedNativeRegistration {
  readonly activeRoot: string;
  readonly receiptPath: string;
}

const MAX_OPEN_CODE_CONFIG_BYTES = 1024 * 1024;

export function openCodeConfigPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  const configRoot = env.XDG_CONFIG_HOME
    ?? (platform === "win32"
      ? env.APPDATA
      : join(env.HOME ?? homedir(), ".config"));
  if (!configRoot || !isAbsolute(configRoot)) {
    throw new Error("OpenCode user configuration root must be absolute");
  }
  return join(configRoot, "opencode", "opencode.json");
}

function parseJsonArray(
  output: string,
  label: string,
): readonly Record<string, unknown>[] {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error(`${label} did not return JSON`);
  }
  if (
    !Array.isArray(value)
    || value.some(
      (entry) =>
        typeof entry !== "object"
        || entry === null
        || Array.isArray(entry),
    )
  ) {
    throw new Error(`${label} did not return an object array`);
  }
  return value as readonly Record<string, unknown>[];
}

function claudeMarketplacePath(
  entry: Readonly<Record<string, unknown>>,
): string | null {
  for (const key of ["path", "sourcePath", "directory", "localPath"]) {
    const value = entry[key];
    if (typeof value === "string" && isAbsolute(value)) return value;
  }
  const source = entry.source;
  if (
    typeof source === "object"
    && source !== null
    && !Array.isArray(source)
  ) {
    for (const key of ["path", "directory"]) {
      const value = (source as Record<string, unknown>)[key];
      if (typeof value === "string" && isAbsolute(value)) return value;
    }
  }
  return null;
}

function exactClaudeOfficialPlugin(
  entry: Readonly<Record<string, unknown>> | undefined,
  plugin: VerifiedOfficialPlugin,
): boolean {
  if (
    entry?.id !== plugin.selector
    || entry.scope !== "user"
    || entry.enabled !== true
    || typeof entry.installPath !== "string"
    || !isAbsolute(entry.installPath)
  ) {
    return false;
  }
  try {
    return gitTreeSha1(entry.installPath, {
      ignoreTopLevel: [".in_use"],
    }) === plugin.pathTree;
  } catch {
    return false;
  }
}

export function registerClaudeOfficialPlugin(
  executable: string,
  plugin: VerifiedOfficialPlugin,
  run: NativeCommandRunner,
): void {
  const matches = parseJsonArray(
    run(executable, ["plugin", "list", "--json"]),
    "Claude plugin list",
  ).filter(({ id }) => id === plugin.selector);
  if (matches.length > 1) {
    throw new Error(`${plugin.selector} has duplicate Claude plugin registrations`);
  }
  if (matches.some(({ scope }) => scope !== "user")) {
    throw new Error(
      `${plugin.selector} collides with a non-user Claude plugin registration`,
    );
  }
  const current = matches.find(({ scope }) => scope === "user");
  if (current !== undefined && !exactClaudeOfficialPlugin(current, plugin)) {
    throw new Error(
      `${plugin.selector} collides with an existing user-owned Claude plugin`,
    );
  }
  if (current === undefined) {
    run(executable, [
      "plugin",
      "install",
      plugin.selector,
      "--scope",
      "user",
    ]);
  }
  const verifiedMatches = parseJsonArray(
    run(executable, ["plugin", "list", "--json"]),
    "Claude plugin list",
  ).filter(
    ({ id, scope }) => id === plugin.selector && scope === "user",
  );
  if (
    verifiedMatches.length !== 1
    || !exactClaudeOfficialPlugin(verifiedMatches[0], plugin)
  ) {
    throw new Error(`${plugin.selector} installation did not match its reviewed tree`);
  }
}

export function registerClaudeRuntime(
  executable: string,
  registration: ManagedNativeRegistration,
  run: NativeCommandRunner,
): void {
  const marketplaceMatches = parseJsonArray(
    run(executable, ["plugin", "marketplace", "list", "--json"]),
    "Claude marketplace list",
  ).filter((entry) => entry.name === "oh-my-harness");
  if (marketplaceMatches.length > 1) {
    throw new Error("Claude marketplace oh-my-harness is registered more than once");
  }
  const marketplace = marketplaceMatches[0];
  if (marketplace !== undefined) {
    const source = claudeMarketplacePath(marketplace);
    if (
      source === null
      || resolve(source) !== resolve(registration.activeRoot)
    ) {
      throw new Error("Claude marketplace oh-my-harness points to another source");
    }
  } else {
    run(executable, [
      "plugin",
      "marketplace",
      "add",
      registration.activeRoot,
    ]);
  }

  const selector = "oh-my-harness@oh-my-harness";
  const selectorMatches = parseJsonArray(
    run(executable, ["plugin", "list", "--json"]),
    "Claude plugin list",
  ).filter((entry) => entry.id === selector);
  if (selectorMatches.length > 1) {
    throw new Error(`${selector} has duplicate Claude plugin registrations`);
  }
  if (selectorMatches.some((entry) => entry.scope !== "user")) {
    throw new Error(`${selector} collides with a non-user Claude plugin registration`);
  }
  const plugin = selectorMatches.find((entry) => entry.scope === "user");
  const sourcePluginDigest = hashManagedDirectory(
    join(registration.activeRoot, "plugins", "oh-my-harness"),
  );
  let installedPluginExact = false;
  if (typeof plugin?.installPath === "string" && isAbsolute(plugin.installPath)) {
    try {
      installedPluginExact = hashManagedDirectory(plugin.installPath, {
        ignoreTopLevel: [".in_use"],
      }) === sourcePluginDigest;
    } catch {
      installedPluginExact = false;
    }
  }
  const pluginCurrent =
    plugin?.version === "0.2.0"
    && plugin.enabled === true
    && installedPluginExact;
  if (plugin !== undefined && !pluginCurrent) {
    throw new Error(`${selector} collides with an existing user-owned Claude plugin`);
  }
  if (plugin === undefined) {
    run(executable, [
      "plugin",
      "install",
      selector,
      "--scope",
      "user",
      "--config",
      `node_path=${process.execPath}`,
      "--config",
      `receipt_path=${registration.receiptPath}`,
    ]);
  }

  if (!claudeRegistrationReady(executable, registration, [], run)) {
    throw new Error("Claude native registration could not be verified");
  }
}

function parseCodexMarketplaces(output: string): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  for (const line of output.split(/\r?\n/u).slice(1)) {
    const match = /^(\S+)\s{2,}(.+?)\s*$/u.exec(line);
    if (match?.[1] && match[2]) {
      if (entries.has(match[1])) {
        throw new Error(`duplicate Codex marketplace registration: ${match[1]}`);
      }
      entries.set(match[1], match[2]);
    }
  }
  return entries;
}

function codexPluginStatus(
  output: string,
  selector: string,
): { readonly installed: boolean; readonly enabled: boolean } {
  const columns = output
    .split(/\r?\n/u)
    .map((entry) => entry.trim().split(/\s{2,}/u))
    .find(([name]) => name === selector);
  const status = columns?.[1] ?? "";
  return {
    enabled: /(?:^|,\s*)enabled(?:,|$)/u.test(status),
    installed: /^installed(?:,|$)/u.test(status),
  };
}

export function registerCodexRuntime(
  executable: string,
  registration: ManagedNativeRegistration,
  run: NativeCommandRunner,
): void {
  const marketplaces = parseCodexMarketplaces(
    run(executable, ["plugin", "marketplace", "list"]),
  );
  const marketplace = marketplaces.get("oh-my-harness");
  if (
    marketplace !== undefined
    && resolve(marketplace) !== resolve(registration.activeRoot)
  ) {
    throw new Error("Codex marketplace oh-my-harness points to another root");
  }
  if (marketplace === undefined) {
    run(executable, [
      "plugin",
      "marketplace",
      "add",
      registration.activeRoot,
      "--json",
    ]);
  }
  const selector = "oh-my-harness@oh-my-harness";
  const pluginStatus = codexPluginStatus(
    run(executable, ["plugin", "list"]),
    selector,
  );
  if (pluginStatus.installed && !pluginStatus.enabled) {
    throw new Error(
      `${selector} collides with an existing disabled Codex plugin registration`,
    );
  }
  if (!pluginStatus.enabled) {
    run(executable, ["plugin", "add", selector, "--json"]);
  }
  const verifiedMarketplace = parseCodexMarketplaces(
    run(executable, ["plugin", "marketplace", "list"]),
  );
  const verifiedStatus = codexPluginStatus(
    run(executable, ["plugin", "list"]),
    selector,
  );
  const verifiedMarketplaceRoot = verifiedMarketplace.get("oh-my-harness");
  if (
    verifiedMarketplaceRoot === undefined
    || resolve(verifiedMarketplaceRoot) !== resolve(registration.activeRoot)
    || !verifiedStatus.installed
    || !verifiedStatus.enabled
  ) {
    throw new Error("Codex native registration could not be verified");
  }
}

export function claudeRegistrationReady(
  executable: string,
  registration: ManagedNativeRegistration,
  officialPlugins: readonly VerifiedOfficialPlugin[],
  run: NativeCommandRunner,
): boolean {
  try {
    const marketplaceMatches = parseJsonArray(
      run(executable, ["plugin", "marketplace", "list", "--json"]),
      "Claude marketplace list",
    ).filter((entry) => entry.name === "oh-my-harness");
    const marketplace = marketplaceMatches[0];
    const marketplacePath = marketplace === undefined
      ? null
      : claudeMarketplacePath(marketplace);
    const plugins = parseJsonArray(
      run(executable, ["plugin", "list", "--json"]),
      "Claude plugin list",
    );
    const managedMatches = plugins.filter(
      (entry) => entry.id === "oh-my-harness@oh-my-harness",
    );
    const sourcePluginDigest = hashManagedDirectory(
      join(registration.activeRoot, "plugins", "oh-my-harness"),
    );
    const managedPlugin = managedMatches[0];
    const managedPluginReady =
      managedMatches.length === 1
      && managedPlugin?.scope === "user"
      && managedPlugin.version === "0.2.0"
      && managedPlugin.enabled === true
      && typeof managedPlugin.installPath === "string"
      && isAbsolute(managedPlugin.installPath)
      && hashManagedDirectory(managedPlugin.installPath, {
          ignoreTopLevel: [".in_use"],
        }) === sourcePluginDigest;
    const officialPluginsReady = officialPlugins.every((expected) => {
      const matches = plugins.filter(({ id }) => id === expected.selector);
      return matches.length === 1
        && exactClaudeOfficialPlugin(matches[0], expected);
    });
    return marketplaceMatches.length === 1
      && marketplacePath !== null
      && resolve(marketplacePath) === resolve(registration.activeRoot)
      && managedPluginReady
      && officialPluginsReady;
  } catch {
    return false;
  }
}

export function codexRegistrationReady(
  executable: string,
  registration: ManagedNativeRegistration,
  run: NativeCommandRunner,
): boolean {
  try {
    const marketplaces = parseCodexMarketplaces(
      run(executable, ["plugin", "marketplace", "list"]),
    );
    const marketplaceRoot = marketplaces.get("oh-my-harness");
    const status = codexPluginStatus(
      run(executable, ["plugin", "list"]),
      "oh-my-harness@oh-my-harness",
    );
    return marketplaceRoot !== undefined
      && resolve(marketplaceRoot) === resolve(registration.activeRoot)
      && status.installed
      && status.enabled;
  } catch {
    return false;
  }
}

export function registerOpenCodeRuntime(
  registration: ManagedNativeRegistration,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): void {
  const configPath = openCodeConfigPath(env, platform);
  const current = existsSync(configPath)
    ? readBoundedRegularFile(configPath, MAX_OPEN_CODE_CONFIG_BYTES)
        .toString("utf8")
    : "{}\n";
  const parsed = parseJsonc(current) as { readonly plugin?: unknown } | undefined;
  if (
    parsed === undefined
    || (parsed.plugin !== undefined && !Array.isArray(parsed.plugin))
  ) {
    throw new Error("OpenCode plugin configuration is not an array");
  }
  const sourcePath = resolve(
    registration.activeRoot,
    ".opencode",
    "plugins",
    "oh-my-harness.js",
  );
  const pluginUrl = pathToFileURL(sourcePath).href;
  const plugins = Array.isArray(parsed.plugin) ? parsed.plugin : [];
  if (plugins.some((entry) => typeof entry !== "string")) {
    throw new Error("OpenCode plugin configuration contains a non-string entry");
  }
  const stringPlugins = plugins as string[];
  if (stringPlugins.includes(pluginUrl) || stringPlugins.includes(sourcePath)) {
    return;
  }
  const edits = modify(current, ["plugin"], [...stringPlugins, pluginUrl], {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  atomicWriteFile(configPath, `${applyEdits(current, edits).trimEnd()}\n`);
}

export function openCodeRegistrationReady(
  runtimePackageRoot: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): boolean {
  const configPath = openCodeConfigPath(env, platform);
  if (!existsSync(configPath)) return false;
  try {
    const value = parseJsonc(
      readBoundedRegularFile(configPath, MAX_OPEN_CODE_CONFIG_BYTES)
        .toString("utf8"),
    ) as { readonly plugin?: unknown } | undefined;
    if (
      !Array.isArray(value?.plugin)
      || value.plugin.some((entry) => typeof entry !== "string")
    ) {
      return false;
    }
    const source = resolve(
      runtimePackageRoot,
      ".opencode",
      "plugins",
      "oh-my-harness.js",
    );
    return value.plugin.includes(source)
      || value.plugin.includes(pathToFileURL(source).href);
  } catch {
    return false;
  }
}
