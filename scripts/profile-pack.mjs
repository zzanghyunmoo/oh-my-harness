#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const RUNTIME_IDS = Object.freeze(["claude-code", "opencode", "codex"]);
const PROFILE_IDS = Object.freeze(["company", "personal"]);

function out(message = "") {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  throw new Error(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function loadV2Catalog() {
  const agents = readJson(
    join(REPOSITORY_ROOT, "harness", "catalog", "agents.json"),
  );
  const profiles = PROFILE_IDS.map((id) =>
    readJson(join(REPOSITORY_ROOT, "harness", "profiles", `${id}.json`)),
  );
  const actualRuntimeIds = agents.agents?.map(({ id }) => id);
  if (
    !Array.isArray(actualRuntimeIds)
    || JSON.stringify([...actualRuntimeIds].sort())
    !== JSON.stringify([...RUNTIME_IDS].sort())
  ) {
    fail(`v2 agent catalog must contain exactly: ${RUNTIME_IDS.join(", ")}`);
  }
  if (profiles.some((profile, index) => profile.id !== PROFILE_IDS[index])) {
    fail(`v2 profiles must contain exactly: ${PROFILE_IDS.join(", ")}`);
  }
  const supported = new Set(RUNTIME_IDS);
  for (const profile of profiles) {
    if (
      !Array.isArray(profile.selectedAgents)
      || profile.selectedAgents.length === 0
      || profile.selectedAgents.some((id) => !supported.has(id))
    ) {
      fail(`${profile.id}: selectedAgents must use the v2 agent catalog`);
    }
  }
  const revision = createHash("sha256")
    .update(JSON.stringify(canonicalize({ agents, profiles })))
    .digest("hex");
  return { profiles, revision };
}

function profileIds(catalog) {
  return catalog.profiles.map(({ id }) => id);
}

function commandVerify() {
  const catalog = loadV2Catalog();
  out(
    `profile:verify compatibility check ok — v2 source ${catalog.revision} `
    + `contains profiles: ${profileIds(catalog).join(", ")}.`,
  );
}

function commandLock(args) {
  const catalog = loadV2Catalog();
  if (args.some((argument) => argument !== "--write")) {
    fail(`unknown lock option: ${args.find((argument) => argument !== "--write")}`);
  }
  out(
    `profile:lock is retained as a v2 compatibility command; `
    + `the canonical source fingerprint is ${catalog.revision}.`,
  );
  out("No legacy profile lock was written.");
}

function commandApply(args) {
  const profileFlagIndex = args.indexOf("--profile");
  const unsupported = args.filter(
    (argument, index) =>
      argument !== "--profile"
      && index !== profileFlagIndex + 1,
  );
  if (unsupported.length > 0) fail(`unknown apply option: ${unsupported[0]}`);

  const requestedProfile =
    profileFlagIndex >= 0 ? args[profileFlagIndex + 1] : "personal";
  if (!requestedProfile) fail("--profile requires a profile id");
  const profileId = requestedProfile === "default" ? "personal" : requestedProfile;
  const catalog = loadV2Catalog();
  const available = profileIds(catalog);
  if (!available.includes(profileId)) {
    fail(`unknown v2 profile ${requestedProfile}; available profiles: ${available.join(", ")}`);
  }

  out(`profile:apply compatibility preview — ${profileId}`);
  out(`Run: omh setup --profile ${profileId}`);
  out("No changes were made.");
}

function printHelp() {
  out(`Usage: node scripts/profile-pack.mjs <command> [options]

Compatibility commands:
  verify                 Validate the canonical v2 catalog.
  lock [--write]         Report the canonical catalog revision without writing a legacy lock.
  apply [--profile id]   Preview the equivalent v2 setup command (default: personal).`);
}

try {
  const [command = "help", ...args] = process.argv.slice(2);
  if (command === "verify") commandVerify();
  else if (command === "lock") commandLock(args);
  else if (command === "apply") commandApply(args);
  else {
    printHelp();
    if (command !== "help" && command !== "--help" && command !== "-h") {
      process.exitCode = 1;
    }
  }
} catch (error) {
  console.error(
    `profile-pack compatibility error: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
