import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { loadSubagentDefaults, parseSubagentDefaults } from "./src/defaults.ts";
import {
  spawnModelDescription,
  spawnReasoningEffortDescription,
} from "./src/prompt.ts";

const errorOf = (settings: unknown) => {
  const config = parseSubagentDefaults(settings);
  assert.equal(config.ok, false);
  return config.ok ? "" : config.error;
};

test("absent settings or section means no defaults", () => {
  assert.deepEqual(parseSubagentDefaults({}), { ok: true, defaults: {} });
  assert.deepEqual(parseSubagentDefaults({ subagents: {} }), {
    ok: true,
    defaults: {},
  });
});

test("valid defaults are parsed per harness", () => {
  assert.deepEqual(
    parseSubagentDefaults({
      theme: "ignored",
      subagents: {
        defaults: {
          pi: { reasoningEffort: "medium" },
          claude: { model: " fable ", reasoningEffort: "high" },
          codex: { model: "gpt-5.6-sol" },
        },
      },
    }),
    {
      ok: true,
      defaults: {
        pi: { reasoningEffort: "medium" },
        claude: { model: "fable", reasoningEffort: "high" },
        codex: { model: "gpt-5.6-sol" },
      },
    },
  );
});

test("invalid defaults fail with the offending key", () => {
  assert.match(
    errorOf({ subagents: { defaults: { claud: { model: "fable" } } } }),
    /subagents\.defaults\.claud: unknown harness/,
  );
  assert.match(
    errorOf({ subagents: { defaults: { claude: { modle: "fable" } } } }),
    /subagents\.defaults\.claude\.modle is not a known setting/,
  );
  assert.match(
    errorOf({ subagents: { defaults: { codex: { model: "" } } } }),
    /codex\.model must be a non-empty string/,
  );
  assert.match(
    errorOf({ subagents: { defaults: { pi: { reasoningEffort: "huge" } } } }),
    /pi\.reasoningEffort must be one of/,
  );
  assert.match(
    errorOf({ subagents: { default: {} } }),
    /subagents\.default is not/,
  );
  assert.match(errorOf({ subagents: [] }), /subagents must be an object/);
});

test("loading reports missing, unparsable, and invalid files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-defaults-"));
  try {
    const file = path.join(dir, "settings.json");
    assert.deepEqual(loadSubagentDefaults(file), { ok: true, defaults: {} });

    fs.writeFileSync(file, "{ not json");
    const unparsable = loadSubagentDefaults(file);
    assert.ok(!unparsable.ok && unparsable.error.startsWith("Cannot parse"));

    fs.writeFileSync(
      file,
      JSON.stringify({ subagents: { defaults: { claude: { model: 1 } } } }),
    );
    const invalid = loadSubagentDefaults(file);
    assert.ok(!invalid.ok && invalid.error.endsWith(`(in ${file})`));

    fs.writeFileSync(
      file,
      `\uFEFF${JSON.stringify({ subagents: { defaults: { claude: { model: "fable" } } } })}`,
    );
    assert.deepEqual(loadSubagentDefaults(file), {
      ok: true,
      defaults: { claude: { model: "fable" } },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tool descriptions show the defaults applied when omitted", () => {
  const config = parseSubagentDefaults({
    subagents: {
      defaults: { claude: { model: "fable", reasoningEffort: "high" } },
    },
  });
  assert.match(
    spawnModelDescription(config),
    /Defaults when omitted: pi: parent model; claude: fable; codex: Codex default\./,
  );
  assert.match(
    spawnReasoningEffortDescription(config),
    /Defaults when omitted: pi: parent level; claude: high; codex: Codex default\./,
  );
  assert.match(
    spawnModelDescription({ ok: false, error: "x" }),
    /every spawn fails until they are fixed/,
  );
});
