/**
 * Nested AGENTS.md
 *
 * Pi loads context files only from the agent dir, the cwd, and the cwd's ancestors.
 * This extension adds Claude Code's nested CLAUDE.md behaviour: when read/edit/write
 * touches a file below the cwd, the context file of every directory between the cwd
 * (exclusive) and the file is appended to that tool result, once per context window.
 *
 * Injected files are recognised by their `<nested_context path="…">` marker in the
 * tool results of the current projection, so the set survives resume, drops what
 * compaction summarised away (and re-injects on the next touch), and follows /tree.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Same order as loadContextFileFromDir in pi's resource-loader.
const CANDIDATES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
const FILE_TOOLS = new Set(["read", "edit", "write"]);
const MARKER = /<nested_context path="([^"]+)">/g;

function contextFileInDir(dir: string): string | undefined {
	for (const name of CANDIDATES) {
		const file = path.join(dir, name);
		try {
			if (existsSync(file) && statSync(file).isFile()) return file;
		} catch {
			// unreadable candidate: try the next one, like pi does
		}
	}
	return undefined;
}

function canonical(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

/** Resolve a tool path like pi's resolveToCwd: strip `@`, expand `~`, resolve against cwd. */
function resolveToolPath(input: string, cwd: string): string {
	let p = input.trim();
	if (p.startsWith("@")) p = p.slice(1);
	if (p === "~") p = homedir();
	else if (p.startsWith("~/")) p = path.join(homedir(), p.slice(2));
	return path.resolve(cwd, p);
}

/** Context files in directories strictly below cwd, from the file's directory up; outermost first. */
function nestedContextFiles(filePath: string, cwd: string): string[] {
	const root = canonical(path.resolve(cwd));
	// The target may not exist yet (write); canonicalise its nearest existing ancestor.
	let dir = path.dirname(filePath);
	let suffix = "";
	while (!existsSync(dir) && path.dirname(dir) !== dir) {
		suffix = path.join(path.basename(dir), suffix);
		dir = path.dirname(dir);
	}
	dir = path.join(canonical(dir), suffix);

	const rel = path.relative(root, dir);
	if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return [];

	const found: string[] = [];
	while (dir !== root) {
		const file = contextFileInDir(dir);
		if (file) found.unshift(file);
		dir = path.dirname(dir);
	}
	return found;
}

function contextDisabled(): boolean {
	// noContextFiles is CLI-only (`--no-context-files` / `-nc`) and not exposed to extensions.
	return process.argv.includes("--no-context-files") || process.argv.includes("-nc");
}

export default function nestedAgentsMd(pi: ExtensionAPI) {
	/** Context files present in the current model context (canonical paths). */
	let injected = new Set<string>();
	/** Context files pi loaded into the system prompt (agent dir, cwd, ancestors). */
	let preloaded = new Set<string>();
	let stale = true;

	function rebuild(ctx: ExtensionContext) {
		injected = new Set();
		for (const message of ctx.sessionManager.buildSessionProjection().messages) {
			if (message.role !== "toolResult") continue;
			for (const part of message.content) {
				if (part.type !== "text") continue;
				for (const match of part.text.matchAll(MARKER)) injected.add(match[1]);
			}
		}
		stale = false;
	}

	const markStale = () => {
		stale = true;
	};
	pi.on("session_start", markStale);
	pi.on("session_compact", markStale);
	pi.on("session_tree", markStale);

	pi.on("before_agent_start", (event) => {
		preloaded = new Set(event.systemPromptOptions.contextFiles.map((file) => canonical(file.path)));
	});

	pi.on("tool_result", (event, ctx) => {
		if (!FILE_TOOLS.has(event.toolName) || contextDisabled()) return;
		// Nested results go to the calling tool (e.g. a codemode script), not to the model.
		if (event.parentToolCallId) return;
		const input = event.input.path;
		if (typeof input !== "string" || input.trim() === "") return;

		if (stale) rebuild(ctx);

		const blocks: string[] = [];
		for (const file of nestedContextFiles(resolveToolPath(input, ctx.cwd), ctx.cwd)) {
			if (injected.has(file) || preloaded.has(file)) continue;
			let content: string;
			try {
				content = readFileSync(file, "utf-8").replace(/^\uFEFF/, "");
			} catch {
				continue;
			}
			// Mark before returning so a parallel call in the same batch skips it.
			injected.add(file);
			const rel = path.relative(canonical(ctx.cwd), file);
			blocks.push(
				`<nested_context path="${file}">\n` +
					`Instructions from ${rel}, which apply to files under ${path.dirname(rel)}/:\n\n` +
					`${content.trim()}\n</nested_context>`,
			);
		}
		if (blocks.length === 0) return;

		return {
			content: [...event.content, { type: "text" as const, text: blocks.join("\n\n") }],
			// Replacing content alone would drop structuredContent (read declares an outputSchema).
			structuredContent: event.structuredContent,
		};
	});
}
