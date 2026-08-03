import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  inspectCompositionAgent,
  plannedAgentOperation,
} from "../../dist/environment/orchestrator.js";

const readyExternal = {
  executablePath: "/trusted/bin/codex",
  id: "codex" as const,
  ownership: "external" as const,
  state: "ready" as const,
};

test("composition-only executable actions are verify-only and fail closed on non-caller identity", () => {
  assert.equal(
    plannedAgentOperation({ compositionOnly: true }, readyExternal),
    "verify-agent",
  );
  assert.throws(
    () => plannedAgentOperation(
      { compositionOnly: true },
      { ...readyExternal, ownership: "managed" },
    ),
    /caller-provided executable identity/i,
  );
  assert.throws(
    () => plannedAgentOperation(
      { compositionOnly: true },
      { ...readyExternal, executablePath: null, ownership: "none", state: "drift" },
    ),
    /caller-provided executable identity/i,
  );
});

test("ordinary profiles preserve reviewed runtime acquisition behavior", () => {
  assert.equal(
    plannedAgentOperation(
      {},
      { ...readyExternal, executablePath: null, ownership: "none", state: "installable" },
    ),
    "acquire-agent",
  );
});

test("composition executable inspection binds actual bytes to the reviewed adapter digest", () => {
  const root = mkdtempSync(join(tmpdir(), "omh-composition-agent-"));
  const command = "fixture-agent";
  const executable = join(
    root,
    process.platform === "win32" ? `${command}.exe` : command,
  );
  const exactBytes = Buffer.from("reviewed executable fixture\n");
  const exactDigest = createHash("sha256").update(exactBytes).digest("hex");
  const platformId = `${process.platform}-${
    process.arch === "arm64" ? "arm64" : "x64"
  }` as const;
  const adapter = {
    command,
    id: "codex" as const,
    platforms: [{
      archive: {
        format: "zip" as const,
        sha256: "a".repeat(64),
        url: "https://example.invalid/codex.zip",
      },
      executable: {
        memberPath: process.platform === "win32" ? `${command}.exe` : command,
        sha256: exactDigest,
      },
      platformId,
    }],
    version: "0.144.4",
  };
  const env = {
    PATH: root,
    ...(process.platform === "win32" ? { PATHEXT: ".EXE" } : {}),
  };
  try {
    writeFileSync(executable, exactBytes);
    if (process.platform !== "win32") chmodSync(executable, 0o755);

    const exact = inspectCompositionAgent(
      adapter,
      platformId,
      env,
      process.cwd(),
    );
    assert.equal(exact.state, "ready");
    assert.equal(exact.ownership, "external");
    assert.equal(exact.executablePath, realpathSync(executable));

    const wrongDigest = structuredClone(adapter);
    wrongDigest.platforms[0]!.executable.sha256 = "b".repeat(64);
    assert.equal(
      inspectCompositionAgent(
        wrongDigest,
        platformId,
        env,
        process.cwd(),
      ).state,
      "drift",
    );

    writeFileSync(executable, "changed executable fixture\n");
    assert.equal(
      inspectCompositionAgent(
        adapter,
        platformId,
        env,
        process.cwd(),
      ).state,
      "drift",
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
