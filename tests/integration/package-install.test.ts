import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadCatalogBundle } from "../../dist/catalog/load.js";
import {
  planPackageInstallations,
  summarizePackageReadiness,
} from "../../dist/install/packages.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("U5 personal and company requiredness drives package readiness", () => {
  const catalog = loadCatalogBundle(REPO_ROOT);
  const personal = catalog.profiles.find(({ id }) => id === "personal");
  const company = catalog.profiles.find(({ id }) => id === "company");
  assert.ok(personal);
  assert.ok(company);

  const findExecutable = (commands: readonly string[]) => (
    ["linear", "ntn", "gh"].includes(commands[0] ?? "")
      ? `/trusted/bin/${commands[0]}`
      : null
  );
  const personalPlan = planPackageInstallations({
    packages: catalog.packages.packages,
    profile: personal,
    os: "darwin",
    findExecutable,
    hasInstaller: () => true,
  });
  const companyPlan = planPackageInstallations({
    packages: catalog.packages.packages,
    profile: company,
    os: "darwin",
    findExecutable,
    hasInstaller: () => true,
  });

  assert.deepEqual(
    personalPlan.filter(({ required }) => required).map(({ id }) => id),
    ["linear", "notion", "github"],
  );
  assert.equal(summarizePackageReadiness(personalPlan).ready, true);
  assert.equal(summarizePackageReadiness(companyPlan).ready, false);
  assert.deepEqual(
    summarizePackageReadiness(companyPlan).blocking,
    ["jira", "confluence", "gitlab"],
  );
});

test("U5 unsupported required package is actionable and cannot report ready", () => {
  const catalog = loadCatalogBundle(REPO_ROOT);
  const personal = catalog.profiles.find(({ id }) => id === "personal");
  assert.ok(personal);

  const plan = planPackageInstallations({
    packages: catalog.packages.packages,
    profile: personal,
    os: "win32",
    findExecutable: () => null,
    hasInstaller: () => true,
  });
  const notion = plan.find(({ id }) => id === "notion");
  assert.equal(notion?.status, "unsupported");
  assert.equal(notion?.required, true);
  assert.match(notion?.guidance ?? "", /Notion CLI|supported/i);
  assert.equal(summarizePackageReadiness(plan).ready, false);
});

test("U5 installed packages remain auth-owned and install plans expose exact guidance", () => {
  const catalog = loadCatalogBundle(REPO_ROOT);
  const company = catalog.profiles.find(({ id }) => id === "company");
  assert.ok(company);

  const plan = planPackageInstallations({
    packages: catalog.packages.packages,
    profile: company,
    os: "linux",
    findExecutable: (commands) => (
      commands[0] === "jira" ? "/usr/local/bin/jira" : null
    ),
    hasInstaller: (command) => command !== "npm",
  });
  const jira = plan.find(({ id }) => id === "jira");
  const confluence = plan.find(({ id }) => id === "confluence");

  assert.equal(jira?.status, "installed-unconfigured");
  assert.equal(jira?.installedPath, "/usr/local/bin/jira");
  assert.match(jira?.authenticationGuidance ?? "", /jira init/);
  assert.equal(confluence?.status, "manager-missing");
  assert.match(confluence?.installGuidance ?? "", /confluence-cli@2\.18\.0/);
  assert.equal(JSON.stringify(plan).includes("token"), false);
});
