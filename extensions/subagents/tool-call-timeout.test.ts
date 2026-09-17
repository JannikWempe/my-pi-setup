import assert from "node:assert/strict";
import test from "node:test";
import { runWithToolCallTimeout, ToolCallTimeoutError } from "../shared/tool-call-timeout.ts";

test("timeout aborts the execution signal even for a non-cooperating tool", async () => {
  let executionSignal: AbortSignal | undefined;
  await assert.rejects(runWithToolCallTimeout("hung", 10, undefined, (signal) => {
    executionSignal = signal;
    return new Promise(() => {});
  }), ToolCallTimeoutError);
  assert.equal(executionSignal?.aborted, true);
});

test("parent cancellation does not wait for a non-cooperating tool", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled");
  const pending = runWithToolCallTimeout("hung", 60_000, controller.signal, () => new Promise(() => {}));
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
});

test("already-aborted calls do not execute", async () => {
  let executed = false;
  await assert.rejects(runWithToolCallTimeout("cancelled", 60_000, AbortSignal.abort(), async () => {
    executed = true;
  }));
  assert.equal(executed, false);
});

test("successful calls preserve their result", async () => {
  assert.equal(await runWithToolCallTimeout("ok", 60_000, undefined, async () => 42), 42);
});
