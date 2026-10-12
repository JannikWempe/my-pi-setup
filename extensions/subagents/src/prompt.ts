/** All model-facing strings for the subagents tools. */

import { describeDefaults, type SubagentDefaultsConfig } from "./defaults.ts";
import type { SubagentOrigin } from "./domain.ts";

/** Describes subagent_spawn, including harnesses and the fixed concurrency cap. */
export const SUBAGENT_SPAWN_TOOL_DESCRIPTION =
  "Spawn a background subagent: a fully autonomous, headless agent with its own context window and the selected harness's normal host permissions. You choose the harness it runs on: pi (in-process pi session, inherits this environment's tools and config), claude (Claude Code), or codex (Codex CLI). Fire-and-forget: this returns immediately with an id. The subagent's final output is queued back to you as a message when it settles, or collect it explicitly with subagent_wait. Children cannot orchestrate more agents/workflows or ask the user, and cannot see this conversation, so the prompt must be self-contained. Only use trusted working directories. Max 4 subagents can be running at once across all harnesses.";

/** Adds background subagent delegation to the parent model's available-tools prompt. */
export const SUBAGENT_SPAWN_PROMPT_SNIPPET =
  "Spawn a background subagent on a chosen harness (pi, Claude Code, or Codex; own context, normal tools) for a self-contained task";

/** Guides the parent model to delegate standalone tasks and avoid unnecessary blocking waits. */
export const SUBAGENT_SPAWN_PROMPT_GUIDELINES = [
  "Use subagent_spawn to delegate self-contained tasks that can run in the background; give it a complete, standalone prompt.",
  "Pick the subagent harness deliberately: pi unless you have a reason to prefer Claude Code or Codex (e.g. the user asked for one, or the task suits that harness).",
  "Omit subagent_spawn's model and reasoning_effort unless the user asked for a specific one; the configured defaults apply.",
  "After subagent_spawn, continue independent work; completed results are delivered automatically when the main session becomes idle. When blocked on a result, call subagent_wait directly: it resumes on completion without polling.",
  "Never use sleep or repeatedly poll subagent_check/subagent_list to wait for subagent completion. Use subagent_wait when blocked; reserve status checks for inspecting progress or diagnosing a problem.",
  "To follow up with an existing subagent (corrections, follow-up questions, continuing its task), use subagent_send: it keeps the subagent's full context, unlike spawning a new one.",
];

/** Model-facing schema descriptions for subagent_spawn task and execution options. */
export const SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS = {
  prompt:
    "Task prompt for the subagent. Must be self-contained: include all needed context, file paths, and what to report back.",
  name: "Short human-readable name for this subagent, shown in listings and the UI",
  harness:
    'Harness to run the subagent on: "pi" (in-process pi session; inherits this environment), "claude" (Claude Code, also called "cc"), or "codex" (Codex CLI). Choose deliberately per task.',
  workingDir:
    "Trusted working directory for the autonomous child (default: current working directory)",
};

const INVALID_DEFAULTS =
  "Subagent defaults in settings.json are invalid, so every spawn fails until they are fixed.";

/** Model parameter description, listing the defaults applied when omitted. */
export function spawnModelDescription(config: SubagentDefaultsConfig) {
  const defaults = config.ok
    ? describeDefaults(config.defaults, "model", {
        pi: "parent model",
        claude: "Claude Code default",
        codex: "Codex default",
      })
    : INVALID_DEFAULTS;
  return `Model, interpreted by the chosen harness (pi: "provider/model-id"; claude: model alias; codex: model slug). Only set when the user asks for a specific model; an unknown model fails the spawn. Defaults when omitted: ${defaults}.`;
}

/** Reasoning-effort parameter description, listing the defaults applied when omitted. */
export function spawnReasoningEffortDescription(
  config: SubagentDefaultsConfig,
) {
  const defaults = config.ok
    ? describeDefaults(config.defaults, "reasoningEffort", {
        pi: "parent level",
        claude: "Claude Code default",
        codex: "Codex default",
      })
    : INVALID_DEFAULTS;
  return `Reasoning effort on a shared scale; the harness maps it to its nearest native equivalent (pi thinking level, codex reasoning effort, claude thinking budget). Only set when the user asks for one. Defaults when omitted: ${defaults}.`;
}

/** Builds the subagent_spawn result that tells the parent model how to continue or inspect the child. */
export function buildSubagentSpawnResult(options: {
  id: string;
  title: string;
  harness: string;
  modelLabel: string;
  cwd: string;
}) {
  return (
    `Spawned subagent ${options.id} "${options.title}" (${options.harness}: ${options.modelLabel}, ${options.cwd}).\n` +
    `It runs in the background. Continue independent work; its completed result will be delivered automatically when the main session becomes idle. ` +
    `If blocked, call subagent_wait(ids: ["${options.id}"]) directly; it resumes on completion. Never sleep or repeatedly poll for completion. ` +
    `Use subagent_cancel to stop it, subagent_check to inspect progress, or subagent_list to see all.`
  );
}

/** Describes explicit blocking collection of one or more subagent results. */
export const SUBAGENT_WAIT_TOOL_DESCRIPTION =
  "Block until all listed subagents have settled, then return their final outputs. Resumes on completion without polling or an arbitrary delay. Continue independent work when possible; when blocked on these results, call subagent_wait directly instead of sleeping or repeatedly checking status.";

/** Model-facing schema description for the subagent ids to await. */
export const SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS = {
  ids: 'Subagent ids to wait for, e.g. ["sa-1", "sa-2"]',
  timeoutSeconds:
    "Optional limit in seconds. On timeout, returns the finished results and lists the subagents still running; nothing is cancelled. Omit to wait until all settle.",
};

/** Describes aborting running subagents while retaining their partial transcripts. */
export const SUBAGENT_CANCEL_TOOL_DESCRIPTION =
  "Cancel one or more running subagents. This aborts their active work but preserves their partial session transcripts on disk.";

/** Model-facing schema description for the subagent ids to cancel. */
export const SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS = {
  ids: 'Subagent ids to cancel, e.g. ["sa-1", "sa-2"]',
};

/** Describes nonblocking inspection of a subagent without consuming its result. */
export const SUBAGENT_CHECK_TOOL_DESCRIPTION =
  "Peek at a subagent's status and recent activity without blocking. Does not consume its result. Use for progress inspection or diagnosis, not repeated completion polling; use subagent_wait when blocked on a result.";

/** Model-facing schema description for the subagent id to inspect. */
export const SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS = {
  id: "Subagent id",
};

/**
 * Standing instructions for delegated children, added to each harness's
 * system/developer prompt. They keep reports compact (the parent pays for
 * every byte in its context) and stop children waiting on a human.
 */
const SUBAGENT_CHILD_INSTRUCTIONS = `You are running as a delegated subagent. Another agent assigned you this task and sees only your final message; no human is watching or available to answer questions.

- Work autonomously. If something is ambiguous, make a reasonable assumption, continue, and state the assumption in your report.
- Stay within the assigned task.
- End with a concise, self-contained report: the outcome or answer, files you changed (paths), and anything unresolved or needing a decision. If you could not finish, say so plainly and why. Do not narrate the steps you took; include details (exact values, paths, snippets) only where the caller needs them.
- The caller may send follow-up messages; answer them the same way.`;

/** Child instructions for a task, or none for user-facing /btw sessions. */
export function childInstructionsFor(origin: SubagentOrigin | undefined) {
  return origin === "btw" ? undefined : SUBAGENT_CHILD_INSTRUCTIONS;
}

/** Describes messaging an existing subagent: steer a running one or start another turn. */
export const SUBAGENT_SEND_TOOL_DESCRIPTION =
  "Send a message to an existing subagent, which keeps its full context. A running subagent receives it as steering for its current run; a finished, failed, cancelled, or restored one starts a new turn, and its result is delivered like a spawn's (automatically when idle, or via subagent_wait). Returns immediately.";

/** Model-facing schema descriptions for subagent_send. */
export const SUBAGENT_SEND_PARAMETER_DESCRIPTIONS = {
  id: "Subagent id",
  message:
    "Message for the subagent. It already has its earlier context, so only say what is new.",
};

/** Describes listing all tracked running and settled subagents. */
export const SUBAGENT_LIST_TOOL_DESCRIPTION =
  "List all subagents (running and finished) with their harness and status.";

/** Builds the child completion/failure wrapper injected into the parent model's context. */
export function buildSubagentResultMessage(options: {
  id: string;
  title: string;
  status: "running" | "done" | "error";
  errorText?: string;
  output: string;
}) {
  const verb = options.status === "error" ? "failed" : "finished";
  let text = `Subagent ${options.id} "${options.title}" ${verb}.`;
  if (options.errorText) text += `\nError: ${options.errorText}`;
  text += `\n\n${options.output}`;
  return text;
}
