import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import registerCcs from "../ccs-provider/index.js";
import registerLiteLlm from "../litellm-provider/index.js";
import registerQuotio from "../quotio-provider/index.js";

type SessionHandler = (event: unknown, context: NotificationContext) => Promise<void>;
type CommandHandler = (args: string, context: NotificationContext) => Promise<void>;

interface NotificationContext {
  readonly ui: {
    notify(message: string, level: "info" | "error"): void;
  };
}

function mockPi() {
  const sessions: SessionHandler[] = [];
  const commands = new Map<string, CommandHandler>();
  const providers: Array<{ id: string; value: any }> = [];
  const pi = {
    on(name: string, handler: SessionHandler) {
      assert.equal(name, "session_start");
      sessions.push(handler);
    },
    registerCommand(name: string, definition: { handler: CommandHandler }) {
      commands.set(name, definition.handler);
    },
    registerProvider(id: string, value: any) {
      providers.push({ id, value });
    },
  } as unknown as ExtensionAPI;
  return { pi, sessions, commands, providers };
}

test("all three proxy extensions keep opt-in guards and select their declared wire protocol", async () => {
  const definitions = [
    { register: registerLiteLlm, id: "litellm", toggle: "ENABLE_LITELLM", base: "LITELLM_BASE_URL", key: "LITELLM_API_KEY", command: "litellm-status", api: "openai-completions" },
    { register: registerQuotio, id: "quotio", toggle: "ENABLE_QUOTIO", base: "QUOTIO_BASE_URL", key: "QUOTIO_API_KEY", command: "quotio-status", api: "openai-completions" },
    { register: registerCcs, id: "ccs", toggle: "ENABLE_CCS", base: "CCS_BASE_URL", key: "CCS_API_KEY", command: "ccs-status", api: "anthropic-messages" },
  ] as const;
  const previousFetch = globalThis.fetch;
  const previous = new Map<string, string | undefined>();
  for (const definition of definitions) {
    for (const name of [definition.toggle, definition.base, definition.key]) previous.set(name, process.env[name]);
  }
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: "gpt-5-codex" }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  try {
    for (const definition of definitions) {
      delete process.env[definition.toggle];
      const disabled = mockPi();
      (definition.register as (pi: any) => void)(disabled.pi);
      assert.equal(disabled.sessions.length, 0);
      assert.equal(disabled.commands.size, 0);

      process.env[definition.toggle] = "true";
      process.env[definition.base] = "http://localhost:9999/v1";
      process.env[definition.key] = "sk-local-test";
      const enabled = mockPi();
      const notices: string[] = [];
      (definition.register as (pi: any) => void)(enabled.pi);
      assert.equal(enabled.sessions.length, 1);
      assert.equal(enabled.commands.has(definition.command), true);
      await enabled.sessions[0]({}, { ui: { notify: (message) => notices.push(message) } });
      assert.equal(enabled.providers[0].id, definition.id);
      assert.equal(enabled.providers[0].value.api, definition.api);
      assert.equal(enabled.providers[0].value.apiKey, "sk-local-test");
      assert.equal(enabled.providers[0].value.models[0].reasoning, true);
      assert.match(notices[0], /1 models available/);
    }
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
