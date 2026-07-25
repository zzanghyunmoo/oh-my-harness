import assert from "node:assert/strict";
import test from "node:test";

import {
  WslTargetPort,
  parseWslDistributionList,
  sanitizeWindowsEnvironment,
} from "../../dist/environment/wsl-target.js";

const NODE_PROBE = JSON.stringify({
  arch: "x64",
  execPath: "/usr/local/bin/node",
  home: "/home/test",
  platform: "linux",
  version: "22.19.0",
});

test("WSL distribution parsing requires the exact Ubuntu WSL2 instance", () => {
  assert.deepEqual(
    parseWslDistributionList(
      "  NAME      STATE           VERSION\r\n* Ubuntu    Running         2\r\n",
      "Ubuntu",
    ),
    { name: "Ubuntu", state: "Running", version: 2 },
  );
  assert.throws(
    () => parseWslDistributionList("Ubuntu Stopped 1", "Ubuntu"),
    /WSL2/,
  );
  assert.throws(
    () => parseWslDistributionList("Debian Running 2", "Ubuntu"),
    /not installed/,
  );
});

test("WSL launches receive an allowlisted Windows environment with WSLENV cleared", () => {
  const environment = sanitizeWindowsEnvironment({
    SystemRoot: "C:\\Windows",
    TEMP: "C:\\Temp",
    PATH: "C:\\attacker",
    WSLENV: "GITHUB_TOKEN/u",
    GITHUB_TOKEN: "secret",
  });

  assert.equal(environment.SystemRoot, "C:\\Windows");
  assert.equal(environment.TEMP, "C:\\Temp");
  assert.equal(environment.WSLENV, "");
  assert.equal(environment.PATH, undefined);
  assert.equal(environment.GITHUB_TOKEN, undefined);
});

test("WSL target stages a dependency-bounded bootstrap and preserves the inner result", async () => {
  const calls: Array<{
    args: readonly string[];
    environment: NodeJS.ProcessEnv;
    stdin?: Buffer;
  }> = [];
  const responses = [
    { exitCode: 0, stdout: "Ubuntu Running 2", stderr: "" },
    { exitCode: 0, stdout: NODE_PROBE, stderr: "" },
    { exitCode: 0, stdout: "/mnt/c/repo", stderr: "" },
    { exitCode: 0, stdout: "/tmp/omh-transport.ABC123", stderr: "" },
    { exitCode: 0, stdout: "", stderr: "" },
    {
      exitCode: 2,
      stdout: JSON.stringify({
        schemaVersion: "1.0.0",
        targetId: "wsl-ubuntu",
        result: {
          command: "setup",
          exitCode: 2,
          state: "preview",
        },
      }),
      stderr: "",
    },
    { exitCode: 0, stdout: "", stderr: "" },
  ];
  const port = new WslTargetPort({
    bundle: async () => Buffer.from("reviewed bundle"),
    environment: {
      SystemRoot: "C:\\Windows",
      WSLENV: "GITHUB_TOKEN/u",
      GITHUB_TOKEN: "secret",
    },
    executable: "C:\\Windows\\System32\\wsl.exe",
    runner: {
      async run(_command, args, options) {
        calls.push({
          args,
          environment: options.environment,
          ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
        });
        return responses.shift()!;
      },
    },
  });

  const result = await port.run({
    argv: ["setup", "--target", "wsl-ubuntu", "--json"],
    repositoryRoot: "C:\\repo",
    startIfStopped: true,
    targetId: "wsl-ubuntu",
  });

  assert.equal(result.state, "preview");
  assert.equal(result.exitCode, 2);
  assert.equal(calls.length, 7);
  assert.deepEqual(calls[4].stdin, Buffer.from("reviewed bundle"));
  assert.match(calls[5].args.join(" "), /\/tmp\/omh-transport\.ABC123\/dist\/cli\/wsl-bootstrap\.js/);
  assert.doesNotMatch(calls[5].args.join(" "), /\/mnt\/c\/repo\/node_modules/);
  assert.ok(calls.every(({ environment }) => environment.WSLENV === ""));
  assert.ok(calls.every(({ environment }) => environment.GITHUB_TOKEN === undefined));
});

test("WSL target rejects stopped read-only inspection and untrusted Node before staging", async () => {
  let calls = 0;
  const stopped = new WslTargetPort({
    bundle: async () => {
      throw new Error("bundle must not be created");
    },
    environment: { SystemRoot: "C:\\Windows" },
    executable: "C:\\Windows\\System32\\wsl.exe",
    runner: {
      async run() {
        calls += 1;
        return { exitCode: 0, stdout: "Ubuntu Stopped 2", stderr: "" };
      },
    },
  });
  const status = await stopped.run({
    argv: ["status", "--target", "wsl-ubuntu", "--json"],
    repositoryRoot: "C:\\repo",
    startIfStopped: false,
    targetId: "wsl-ubuntu",
  });
  assert.equal(status.state, "unverifiable");
  assert.equal(calls, 1);

  const leaked = new WslTargetPort({
    bundle: async () => {
      throw new Error("bundle must not be created");
    },
    environment: { SystemRoot: "C:\\Windows" },
    executable: "C:\\Windows\\System32\\wsl.exe",
    runner: {
      async run() {
        calls += 1;
        return calls === 2
          ? { exitCode: 0, stdout: "Ubuntu Running 2", stderr: "" }
          : {
              exitCode: 0,
              stdout: JSON.stringify({
                ...JSON.parse(NODE_PROBE),
                execPath: "/mnt/c/Program Files/nodejs/node.exe",
              }),
              stderr: "",
            };
      },
    },
  });
  await assert.rejects(
    () => leaked.run({
      argv: ["setup", "--target", "wsl-ubuntu", "--json"],
      repositoryRoot: "C:\\repo",
      startIfStopped: true,
      targetId: "wsl-ubuntu",
    }),
    /trusted Linux Node/,
  );
});

test("WSL target rejects an old Node and path translation failure before staging", async () => {
  for (const responses of [
    [
      { exitCode: 0, stdout: "Ubuntu Running 2", stderr: "" },
      {
        exitCode: 0,
        stdout: JSON.stringify({
          ...JSON.parse(NODE_PROBE),
          version: "18.19.1",
        }),
        stderr: "",
      },
    ],
    [
      { exitCode: 0, stdout: "Ubuntu Running 2", stderr: "" },
      { exitCode: 0, stdout: NODE_PROBE, stderr: "" },
      { exitCode: 1, stdout: "", stderr: "translation failed" },
    ],
  ]) {
    let index = 0;
    const port = new WslTargetPort({
      bundle: async () => {
        throw new Error("bundle must not be created");
      },
      environment: { SystemRoot: "C:\\Windows" },
      executable: "C:\\Windows\\System32\\wsl.exe",
      runner: {
        async run() {
          return responses[index++]!;
        },
      },
    });
    await assert.rejects(
      () => port.run({
        argv: ["setup", "--target", "wsl-ubuntu", "--json"],
        repositoryRoot: "C:\\repo",
        startIfStopped: true,
        targetId: "wsl-ubuntu",
      }),
      /trusted Linux Node|path translation failed/,
    );
  }
});

test("WSL target rejects malformed, oversized, and wrong-target envelopes", async () => {
  for (const response of [
    "not json",
    "x".repeat(4 * 1024 * 1024 + 1),
    JSON.stringify({
      schemaVersion: "1.0.0",
      targetId: "windows-native",
      result: { command: "setup" },
    }),
  ]) {
    let index = 0;
    const port = new WslTargetPort({
      bundle: async () => Buffer.from("bundle"),
      environment: { SystemRoot: "C:\\Windows" },
      executable: "C:\\Windows\\System32\\wsl.exe",
      runner: {
        async run() {
          index += 1;
          return [
            { exitCode: 0, stdout: "Ubuntu Running 2", stderr: "" },
            { exitCode: 0, stdout: NODE_PROBE, stderr: "" },
            { exitCode: 0, stdout: "/mnt/c/repo", stderr: "" },
            { exitCode: 0, stdout: "/tmp/omh-transport.ABC123", stderr: "" },
            { exitCode: 0, stdout: "", stderr: "" },
            { exitCode: 2, stdout: response, stderr: "" },
            { exitCode: 0, stdout: "", stderr: "" },
          ][index - 1]!;
        },
      },
    });
    await assert.rejects(
      () => port.run({
        argv: ["setup", "--target", "wsl-ubuntu", "--json"],
        repositoryRoot: "C:\\repo",
        startIfStopped: true,
        targetId: "wsl-ubuntu",
      }),
      /bounded JSON|target identity/,
    );
  }
});
