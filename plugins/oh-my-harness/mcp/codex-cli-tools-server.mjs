#!/usr/bin/env node

process.env.OH_MY_HARNESS_RUNTIME = "codex";
await import("./cli-tools-server.mjs");
