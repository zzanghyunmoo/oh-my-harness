import assert from "node:assert/strict";
import test from "node:test";

import { runOmh } from "../../dist/cli/main.js";

test("explicit WSL commands dispatch through the target port exactly once", async () => {
  const calls: unknown[] = [];
  const expected = {
    command: "setup",
    exitCode: 3,
    state: "blocked",
  };
  const result = await runOmh(
    ["setup", "--target", "wsl-ubuntu", "--json"],
    {
      repositoryRoot: process.cwd(),
      targetPort: {
        async run(request) {
          calls.push(request);
          return expected;
        },
      },
    },
  );

  assert.deepEqual(result, expected);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    argv: ["setup", "--target", "wsl-ubuntu", "--json"],
    repositoryRoot: process.cwd(),
    startIfStopped: true,
    targetId: "wsl-ubuntu",
  });
});
