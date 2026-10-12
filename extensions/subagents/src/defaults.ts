/**
 * Per-machine spawn defaults, read from the `subagents.defaults` key of
 * `~/.pi/agent/settings.json`. That file is machine-local (not committed), so
 * each machine names models from the providers it actually has.
 *
 *   "subagents": {
 *     "defaults": {
 *       "pi": { "model": "github-copilot/claude-opus-5-5", "reasoningEffort": "high" },
 *       "claude": { "model": "fable", "reasoningEffort": "high" },
 *       "codex": { "model": "gpt-5.6-sol", "reasoningEffort": "high" }
 *     }
 *   }
 *
 * Read once when the extension loads: the same snapshot feeds the tool
 * description and every spawn, so the model never sees defaults that differ
 * from the ones applied. Edits take effect on /reload or a new session.
 * An invalid config never falls back silently: every spawn fails with the
 * config error until it is fixed.
 */

import * as fs from "node:fs";
import {
  BACKEND_NAMES,
  type BackendName,
  REASONING_EFFORTS,
  type ReasoningEffort,
} from "./domain.ts";

export interface HarnessDefaults {
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
}

export type SubagentDefaults = Partial<Record<BackendName, HarnessDefaults>>;

export type SubagentDefaultsConfig =
  | { readonly ok: true; readonly defaults: SubagentDefaults }
  | { readonly ok: false; readonly error: string };

const HARNESS_KEYS = ["model", "reasoningEffort"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isBackendName = (key: string): key is BackendName =>
  (BACKEND_NAMES as ReadonlyArray<string>).includes(key);

const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  (REASONING_EFFORTS as ReadonlyArray<unknown>).includes(value);

/** Validate the parsed settings object. Unknown keys are errors, not ignored. */
export function parseSubagentDefaults(
  settings: unknown,
): SubagentDefaultsConfig {
  if (!isRecord(settings)) return { ok: true, defaults: {} };
  const section = settings.subagents;
  if (section === undefined) return { ok: true, defaults: {} };
  if (!isRecord(section)) {
    return { ok: false, error: "subagents must be an object." };
  }
  for (const key of Object.keys(section)) {
    if (key !== "defaults") {
      return { ok: false, error: `subagents.${key} is not a known setting.` };
    }
  }
  const raw = section.defaults;
  if (raw === undefined) return { ok: true, defaults: {} };
  if (!isRecord(raw)) {
    return { ok: false, error: "subagents.defaults must be an object." };
  }

  const defaults: Partial<Record<BackendName, HarnessDefaults>> = {};
  for (const [harness, entry] of Object.entries(raw)) {
    const at = `subagents.defaults.${harness}`;
    if (!isBackendName(harness)) {
      return {
        ok: false,
        error: `${at}: unknown harness (expected ${BACKEND_NAMES.join(", ")}).`,
      };
    }
    if (!isRecord(entry)) {
      return { ok: false, error: `${at} must be an object.` };
    }
    for (const key of Object.keys(entry)) {
      if (!HARNESS_KEYS.includes(key)) {
        return {
          ok: false,
          error: `${at}.${key} is not a known setting (expected ${HARNESS_KEYS.join(", ")}).`,
        };
      }
    }
    const { model, reasoningEffort } = entry;
    if (
      model !== undefined &&
      (typeof model !== "string" || model.trim() === "")
    ) {
      return { ok: false, error: `${at}.model must be a non-empty string.` };
    }
    if (reasoningEffort !== undefined && !isReasoningEffort(reasoningEffort)) {
      return {
        ok: false,
        error: `${at}.reasoningEffort must be one of ${REASONING_EFFORTS.join(", ")}.`,
      };
    }
    defaults[harness] = {
      ...(model !== undefined ? { model: model.trim() } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    };
  }
  return { ok: true, defaults };
}

/** Read and validate the defaults; a missing settings file means no defaults. */
export function loadSubagentDefaults(
  settingsPath: string,
): SubagentDefaultsConfig {
  let text: string;
  try {
    text = fs.readFileSync(settingsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, defaults: {} };
    }
    return {
      ok: false,
      error: `Cannot read ${settingsPath}: ${(error as Error).message}`,
    };
  }
  let settings: unknown;
  try {
    settings = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    return {
      ok: false,
      error: `Cannot parse ${settingsPath}: ${(error as Error).message}`,
    };
  }
  const config = parseSubagentDefaults(settings);
  return config.ok
    ? config
    : { ok: false, error: `${config.error} (in ${settingsPath})` };
}

/** One-line summary for the tool schema, e.g. "pi: parent model; claude: fable". */
export function describeDefaults(
  defaults: SubagentDefaults,
  field: keyof HarnessDefaults,
  fallback: Record<BackendName, string>,
) {
  return BACKEND_NAMES.map(
    (harness) =>
      `${harness}: ${defaults[harness]?.[field] ?? fallback[harness]}`,
  ).join("; ");
}
