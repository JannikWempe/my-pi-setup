import assert from "node:assert/strict";
import test from "node:test";
import { runCommand } from "./src/process.ts";
import { createRuntime } from "./src/runtime.ts";

const runtime = createRuntime();

test.after(async () => {
  await runtime.dispose();
});

const runNode = (source: string, timeout = 1_000) =>
  runtime.runPromise(
    runCommand(
      process.execPath,
      ["--input-type=module", "--eval", source],
      process.cwd(),
      timeout,
    ),
  );

test("captures output and tolerates command failures", async () => {
  const success = await runNode(
    'process.stdout.write("out"); process.stderr.write("err")',
  );
  assert.deepEqual(success, { code: 0, stderr: "err", stdout: "out" });

  const failure = await runNode("process.exitCode = 7");
  assert.equal(failure.code, 7);
});

test("renders platform failures without making callers handle them", async () => {
  const command = "git-info-command-that-does-not-exist";
  const result = await runtime.runPromise(
    runCommand(command, [], process.cwd(), 1_000),
  );

  assert.equal(result.code, 1);
  assert.match(result.stderr, new RegExp(`Failed to run ${command}:`));
  assert.match(result.stderr, /NotFound|not found|ENOENT/i);
});

test("bounds and drains stdout and stderr independently", async () => {
  const limit = 10 * 1_024 * 1_024;
  const marker = "\n[command output truncated]\n";
  const result = await runNode(
    `
    import { once } from "node:events";
    for (let i = 0; i < 12; i++) {
      for (const stream of [process.stdout, process.stderr]) {
        if (!stream.write("x".repeat(1024 * 1024))) await once(stream, "drain");
      }
    }
  `,
    10_000,
  );
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "x".repeat(limit) + marker);
  assert.equal(result.stderr, "x".repeat(limit) + marker);
});

test("literal truncation marker does not suppress subsequent output", async () => {
  const marker = "\n[command output truncated]\n";
  const result = await runNode(`
    process.stdout.write(${JSON.stringify(marker)});
    setTimeout(() => process.stdout.write("after"), 100);
  `);
  assert.equal(result.stdout, marker + "after");
});

test("reports command timeouts as failures", async () => {
  const result = await runNode("setTimeout(() => {}, 1_000)", 20);
  assert.equal(result.code, -1);
});
