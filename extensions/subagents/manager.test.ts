/**
 * End-to-end smoke tests: manager behavior through a real ManagedRuntime,
 * exactly as the tool handlers drive it. The registry is test-only: scripted
 * stub sessions registered under the claude/codex names (the production
 * backends launch real processes and have their own live test files), plus
 * the real pi backend for its cheap registry precondition.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { BackendRegistry, type SubagentBackend } from "./src/backend.ts";
import { piBackend } from "./src/backends/pi.ts";
import { makeStubBackend } from "./src/backends/stub.ts";
import type {
  BackendName,
  ParentContext,
  SpawnTask,
  SubagentRecord,
} from "./src/domain.ts";
import {
  SubagentManager,
  SubagentManagerLive,
  type SubagentManagerShape,
} from "./src/manager.ts";
import { runTool } from "./src/runtime.ts";

const TestRegistryLive = Layer.sync(BackendRegistry, () => {
  const backends: SubagentBackend[] = [
    piBackend,
    makeStubBackend({
      backend: "claude",
      defaultModelLabel: "claude/sonnet",
      contextWindow: 200_000,
      toolName: "Bash",
      cadenceMs: 40,
    }),
    makeStubBackend({
      backend: "codex",
      defaultModelLabel: "codex/gpt-5-codex",
      contextWindow: 272_000,
      toolName: "shell",
      cadenceMs: 30,
    }),
  ];
  return new Map<BackendName, SubagentBackend>(
    backends.map((backend) => [backend.name, backend]),
  );
});

const createTestRuntime = () =>
  ManagedRuntime.make(
    SubagentManagerLive.pipe(Layer.provide(TestRegistryLive)),
  );

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: false,
};

function task(prompt: string): SpawnTask {
  return { prompt, title: "test", cwd: process.cwd(), parent };
}

async function withManager(
  run: (
    manager: SubagentManagerShape,
    runtime: ReturnType<typeof createTestRuntime>,
  ) => Promise<void>,
) {
  const runtime = createTestRuntime();
  try {
    const manager = await runtime.runPromise(SubagentManager);
    await run(manager, runtime);
  } finally {
    await runtime.dispose();
  }
}

test("stub subagent completes and delivers a final result", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("Say hello to the tests")),
    );
    assert.equal(snap.status, "running");
    assert.equal(snap.backend, "claude");
    assert.ok(snap.meta.sessionFilePath);

    await runTool(runtime, manager.waitFor([snap.id]));
    const done = manager.view.get(snap.id);
    assert.ok(done);
    assert.equal(done.status, "done");
    assert.match(
      done.finalText,
      /\[stub:claude\] completed: Say hello to the tests/,
    );
    assert.ok(done.turns >= 2);
    assert.ok(done.transcript.some((item) => item.kind === "toolResult"));
    // The waitFor marked the settle as consumed.
    assert.deepEqual(settled, [{ id: snap.id, consumed: true }]);
  });
});

test("FAIL: prompts settle as errors; unconsumed settles are delivered", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.spawn("codex", task("FAIL: blow up please")),
    );
    // Poll without wait-interest so the settle is delivered unconsumed.
    while (manager.view.get(snap.id)?.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const failed = manager.view.get(snap.id);
    assert.equal(failed?.status, "error");
    assert.match(failed?.errorText ?? "", /task failed/);
    assert.deepEqual(settled, [{ id: snap.id, consumed: false }]);
  });
});

test("cancel interrupts a running stub subagent", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("Long running task")),
    );
    const report = await runTool(runtime, manager.cancel([snap.id]));
    assert.deepEqual(report, [
      { id: snap.id, title: "test", status: "error", cancelled: true },
    ]);
    assert.equal(manager.view.get(snap.id)?.errorText, "Run was aborted");
  });
});

test("spawn origin propagates to ids, snapshots, and settlement", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; origin: string }> = [];
    manager.view.setOnSettled((snap) =>
      settled.push({ id: snap.id, origin: snap.origin }),
    );

    const model = await runTool(
      runtime,
      manager.spawn("codex", task("model task")),
    );
    const btw = await runTool(
      runtime,
      manager.spawn("claude", { ...task("side question"), origin: "btw" }),
    );

    assert.match(model.id, /^sa-/);
    assert.equal(model.origin, "model");
    assert.match(btw.id, /^btw-/);
    assert.equal(btw.origin, "btw");

    await runTool(runtime, manager.cancel([model.id, btw.id]));
    assert.deepEqual(
      settled.sort((a, b) => a.id.localeCompare(b.id)),
      [
        { id: btw.id, origin: "btw" },
        { id: model.id, origin: "model" },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });
});

test("the global concurrency cap includes by-the-way sessions", async () => {
  await withManager(async (manager, runtime) => {
    const tasks: SpawnTask[] = [
      { ...task("side question"), origin: "btw" },
      task("Task 2"),
      task("Task 3"),
      task("Task 4"),
    ];
    const spawns = await runTool(
      runtime,
      Effect.forEach(tasks, (spawnTask) => manager.spawn("codex", spawnTask), {
        concurrency: "unbounded",
      }),
    );
    assert.equal(spawns.length, 4);
    await assert.rejects(
      runTool(
        runtime,
        manager.spawn("codex", {
          ...task("another side question"),
          origin: "btw",
        }),
      ),
      /Max 4 subagents/,
    );
  });
});

test("the concurrency cap rejects a fifth running subagent", async () => {
  await withManager(async (manager, runtime) => {
    const spawns = await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3, 4],
        (n) => manager.spawn("codex", task(`Task ${n}`)),
        { concurrency: "unbounded" },
      ),
    );
    assert.equal(spawns.length, 4);
    await assert.rejects(
      runTool(runtime, manager.spawn("codex", task("Task 5"))),
      /Max 4 subagents/,
    );
  });
});

test("pi spawn fails fast without the parent model registry", async () => {
  await withManager(async (manager, runtime) => {
    await assert.rejects(
      runTool(runtime, manager.spawn("pi", task("needs a registry"))),
      /model registry/,
    );
    // The failed spawn must release its concurrency reservation.
    const snap = await runTool(runtime, manager.spawn("codex", task("ok")));
    assert.equal(snap.backend, "codex");
  });
});

test("idle restarts respect the concurrency cap", async () => {
  await withManager(async (manager, runtime) => {
    // Settle one subagent, then fill all four slots with running ones.
    const settled = await runTool(
      runtime,
      manager.spawn("claude", task("early finisher")),
    );
    await runTool(runtime, manager.waitFor([settled.id]));
    await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3, 4],
        (n) => manager.spawn("codex", task(`Task ${n}`)),
        { concurrency: "unbounded" },
      ),
    );
    // Restarting the settled one would be a fifth concurrent run.
    await assert.rejects(
      runTool(runtime, manager.send(settled.id, "go again")),
      /Max 4 subagents/,
    );
    assert.equal(manager.view.get(settled.id)?.status, "done");
  });
});

test("send steers an idle subagent into another turn", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("First turn")),
    );
    await runTool(runtime, manager.waitFor([snap.id]));
    const afterFirst = manager.view.get(snap.id);
    assert.equal(afterFirst?.status, "done");

    await runTool(runtime, manager.send(snap.id, "Second turn"));
    // The fresh run flips the status back to running...
    while (manager.view.get(snap.id)?.status !== "running") {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await runTool(runtime, manager.waitFor([snap.id]));
    const afterSecond = manager.view.get(snap.id);
    assert.equal(afterSecond?.status, "done");
    assert.match(afterSecond?.finalText ?? "", /Second turn/);
  });
});

/** Latest record per id, as the extension reads them back on session_start. */
function latestRecords(records: SubagentRecord[]) {
  return [...new Map(records.map((record) => [record.id, record])).values()];
}

test("persisted records restore finished and interrupted subagents", async () => {
  const records: SubagentRecord[] = [];
  let finishedId = "";
  let runningId = "";
  await withManager(async (manager, runtime) => {
    manager.view.setOnPersist((record) => records.push(record));
    const finished = await runTool(
      runtime,
      manager.spawn("claude", { ...task("Finish me"), model: "opus" }),
    );
    await runTool(runtime, manager.waitFor([finished.id]));
    const running = await runTool(
      runtime,
      manager.spawn("codex", task("Still going at shutdown")),
    );
    finishedId = finished.id;
    runningId = running.id;
  });

  const latest = latestRecords(records);
  assert.equal(latest.find((r) => r.id === finishedId)?.status, "done");
  assert.equal(latest.find((r) => r.id === finishedId)?.model, "opus");
  // Teardown must not overwrite the last live state with its own settle.
  assert.equal(latest.find((r) => r.id === runningId)?.status, "running");

  await withManager(async (manager, runtime) => {
    await runTool(
      runtime,
      manager.restore(latest, () => parent),
    );
    const finished = manager.view.get(finishedId);
    assert.equal(finished?.status, "done");
    assert.match(finished?.finalText ?? "", /completed: Finish me/);
    assert.ok(finished?.meta.nativeSessionId);
    const interrupted = manager.view.get(runningId);
    assert.equal(interrupted?.status, "error");
    assert.match(interrupted?.errorText ?? "", /parent session closed/);

    // Waiting on a dormant subagent returns immediately.
    await runTool(runtime, manager.waitFor([runningId]));

    // New ids continue after the restored ones.
    const next = await runTool(runtime, manager.spawn("codex", task("next")));
    assert.notEqual(next.id, finishedId);
    assert.notEqual(next.id, runningId);
    assert.equal(Number(next.id.slice(3)), 3);
  });
});

test("sending to a restored subagent resumes its native session", async () => {
  const records: SubagentRecord[] = [];
  let id = "";
  let sessionFilePath: string | undefined;
  await withManager(async (manager, runtime) => {
    manager.view.setOnPersist((record) => records.push(record));
    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("First run")),
    );
    await runTool(runtime, manager.waitFor([snap.id]));
    id = snap.id;
    sessionFilePath = snap.meta.sessionFilePath;
  });

  await withManager(async (manager, runtime) => {
    const persisted: SubagentRecord[] = [];
    manager.view.setOnPersist((record) => persisted.push(record));
    await runTool(
      runtime,
      manager.restore(latestRecords(records), () => parent),
    );
    // Restoring alone does not re-persist unchanged records.
    assert.equal(persisted.length, 0);

    await runTool(runtime, manager.send(id, "Second run"));
    // No polling: waitFor treats the dispatched restart as running.
    await runTool(runtime, manager.waitFor([id]));
    const resumed = manager.view.get(id);
    assert.equal(resumed?.status, "done");
    assert.match(resumed?.finalText ?? "", /completed: Second run/);
    assert.equal(resumed?.meta.sessionFilePath, sessionFilePath);
    assert.equal(persisted.at(-1)?.status, "done");
  });
});

test("a failed resume reports why and frees its running slot", async () => {
  await withManager(async (manager, runtime) => {
    await runTool(
      runtime,
      manager.restore(
        [
          {
            version: 1,
            id: "sa-7",
            origin: "model",
            backend: "codex",
            title: "orphan",
            prompt: "orphan",
            cwd: process.cwd(),
            status: "done",
            createdAt: Date.now(),
            meta: { backend: "codex" },
            usage: {},
            finalText: "old answer",
            turns: 1,
          },
        ],
        () => undefined,
      ),
    );
    await assert.rejects(
      runTool(runtime, manager.send("sa-7", "again")),
      /no parent session context/,
    );
    const snap = manager.view.get("sa-7");
    assert.equal(snap?.status, "done");
    assert.match(snap?.errorText ?? "", /no parent session context/);
    // The slot reserved for the restart was released.
    const spawned = await runTool(
      runtime,
      Effect.forEach(
        [task("a"), task("b"), task("c"), task("d")],
        (spawnTask) => manager.spawn("codex", spawnTask),
        { concurrency: "unbounded" },
      ),
    );
    assert.equal(spawned.length, 4);
    assert.equal(spawned[0]?.id.startsWith("sa-"), true);
    assert.ok(spawned.every((snap) => Number(snap.id.slice(3)) > 7));
  });
});
