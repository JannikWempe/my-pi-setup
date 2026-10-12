import assert from "node:assert/strict";
import test from "node:test";
import { resolvePiModel } from "./src/backends/pi.ts";

const models = [
  { provider: "anthropic", id: "claude-opus-5-5" },
  { provider: "claude-bridge", id: "claude-opus-5-5" },
  { provider: "openai-codex", id: "gpt-6.1-sol" },
];
const registry = {
  find: (provider: string, id: string) =>
    models.find((m) => m.provider === provider && m.id === id) as any,
  getAll: () => models as any,
};

test("a model hint may not pick the anthropic provider", () => {
  assert.throws(
    () => resolvePiModel(registry, "anthropic/claude-opus-5-5", undefined),
    /anthropic provider, which pi subagents must not use/,
  );
  // A bare id resolves through the inherited provider first.
  assert.throws(
    () =>
      resolvePiModel(registry, "claude-opus-5-5", {
        provider: "anthropic",
        id: "claude-opus-5-5",
      }),
    /must not use/,
  );
  assert.equal(
    resolvePiModel(registry, "claude-bridge/claude-opus-5-5", undefined)
      ?.provider,
    "claude-bridge",
  );
});

test("inheriting an anthropic parent model stays allowed", () => {
  assert.equal(
    resolvePiModel(registry, undefined, {
      provider: "anthropic",
      id: "claude-opus-5-5",
    })?.provider,
    "anthropic",
  );
});
