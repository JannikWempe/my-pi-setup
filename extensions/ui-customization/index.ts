import { homedir } from "node:os";
import { relative } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import {
  getCapabilities,
  hyperlink,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  emptyGitInfoState,
  emptyModelInfoState,
  GIT_INFO_CHANNEL,
  MODEL_INFO_CHANNEL,
  REFRESH_CHANNEL,
  isGitInfoState,
  isModelInfoState,
} from "../shared/dashboard-state.ts";

type Rgb = [number, number, number];
interface RenderableNode {
  children?: RenderableNode[];
  invalidate(): void;
  render(width: number): string[];
}

interface ExpandableTextNode extends RenderableNode {
  getCollapsedText(): string;
  getExpandedText(): string;
  setExpanded(expanded: boolean): void;
  setText(text: string): void;
  text: string;
  skillCategoriesApplied?: boolean;
}

interface DashboardTui extends RenderableNode {
  requestRender(force?: boolean): void;
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

// Context usage thresholds. Adjust these token counts to change when warnings appear.
const CONTEXT_WARNING_TOKENS = 100_000;
const CONTEXT_DANGER_TOKENS = 140_000;

const PALETTE: Rgb[] = [
  [22, 83, 189],
  [48, 129, 247],
  [93, 171, 255],
  [151, 205, 255],
  [93, 171, 255],
  [48, 129, 247],
];
const TITLE_LINES = [
  "  ██████╗  ██╗ ",
  "  ██╔══██╗ ██║ ",
  "  ██████╔╝ ██║ ",
  "  ██╔═══╝  ██║ ",
  "  ██║      ██║ ",
  "  ╚═╝      ╚═╝ ",
];
const ANSI_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

// Strip untrusted terminal sequences before adding dashboard styling.
const OSC_PATTERN =
  /(?:\x1b\]|\x9d)(?:[^\x07\x1b\x9c]|\x1b(?!\\))*(?:\x07|\x1b\\|\x9c)/g;
const CSI_PATTERN = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g;
const ESCAPE_PATTERN = /\x1b(?:[()][0-2A-Z]|[ -/]*[@-~])/g;

function sanitizeTerminalLabel(text: string) {
  return text
    .replace(OSC_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(ESCAPE_PATTERN, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

function mix(a: number, b: number, amount: number) {
  return Math.round(a + (b - a) * amount);
}

function sampleGradient(position: number) {
  const wrapped = ((position % 1) + 1) % 1;
  const scaled = wrapped * PALETTE.length;
  const index = Math.floor(scaled);
  const nextIndex = (index + 1) % PALETTE.length;
  const amount = scaled - index;
  const start = PALETTE[index]!;
  const end = PALETTE[nextIndex]!;

  return [
    mix(start[0], end[0], amount),
    mix(start[1], end[1], amount),
    mix(start[2], end[2], amount),
  ] satisfies Rgb;
}

function foreground([red, green, blue]: Rgb, text: string) {
  return `\x1b[38;2;${red};${green};${blue}m${text}${RESET}`;
}

function gradientText(text: string, phase: number) {
  const characters = [...text];
  const span = Math.max(characters.length - 1, 1);

  return characters
    .map((character, index) =>
      character === " "
        ? character
        : foreground(sampleGradient(index / span + phase), character),
    )
    .join("");
}

function hasChildren(
  component: RenderableNode,
): component is RenderableNode & { children: RenderableNode[] } {
  return Array.isArray(component.children);
}

function stripAnsi(text: string) {
  return text.replace(ANSI_PATTERN, "");
}

function renderedText(component: RenderableNode) {
  try {
    return stripAnsi(component.render(200).join("\n"));
  } catch {
    return "";
  }
}

function isExpandableTextNode(
  component: RenderableNode,
): component is ExpandableTextNode {
  const candidate = component as Partial<ExpandableTextNode>;
  return (
    typeof candidate.getCollapsedText === "function" &&
    typeof candidate.getExpandedText === "function" &&
    typeof candidate.setExpanded === "function" &&
    typeof candidate.setText === "function" &&
    typeof candidate.text === "string"
  );
}

export function extractModelInvocableSkillNames(systemPrompt: string) {
  const skillsBlock = systemPrompt.match(
    /<available_skills>([\s\S]*?)<\/available_skills>/,
  )?.[1];
  if (!skillsBlock) return new Set<string>();

  return new Set(
    [...skillsBlock.matchAll(/<name>([^<]+)<\/name>/g)].map(
      (match) => match[1]!,
    ),
  );
}

function parseSkillNames(collapsedText: string) {
  const lines = stripAnsi(collapsedText).split("\n");
  if (lines[0]?.trim() !== "[Skills]") return [];

  return lines
    .slice(1)
    .join(" ")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

export function categorizeSkillsSection(
  component: RenderableNode,
  modelInvocableNames: ReadonlySet<string>,
  labelStyle: (text: string) => string,
  valueStyle: (text: string) => string,
) {
  if (isExpandableTextNode(component)) {
    if (component.skillCategoriesApplied) return false;

    const getOriginalCollapsedText = component.getCollapsedText.bind(component);
    const getOriginalExpandedText = component.getExpandedText.bind(component);
    const originalCollapsed = getOriginalCollapsedText();
    const skillNames = parseSkillNames(originalCollapsed);
    if (skillNames.length > 0) {
      const modelInvocable = skillNames.filter((name) =>
        modelInvocableNames.has(name),
      );
      const userOnly = skillNames.filter(
        (name) => !modelInvocableNames.has(name),
      );
      if (userOnly.length === 0) return false;

      const originalExpanded = getOriginalExpandedText();
      const wasExpanded = component.text === originalExpanded;
      const summary = () =>
        [
          getOriginalCollapsedText().split("\n", 1)[0]!,
          `  ${labelStyle("model-invocable")}  ${valueStyle(modelInvocable.join(", ") || "—")}`,
          `  ${labelStyle("user-only")}        ${valueStyle(userOnly.join(", "))}`,
        ].join("\n");
      const expandedDetails = () =>
        getOriginalExpandedText().split("\n").slice(1).join("\n");

      component.getCollapsedText = summary;
      component.getExpandedText = () => `${summary()}\n${expandedDetails()}`;
      component.skillCategoriesApplied = true;
      component.setText(
        wasExpanded
          ? component.getExpandedText()
          : component.getCollapsedText(),
      );
      component.invalidate();
      return true;
    }
  }

  if (!hasChildren(component)) return false;
  for (const child of component.children) {
    if (
      categorizeSkillsSection(
        child,
        modelInvocableNames,
        labelStyle,
        valueStyle,
      )
    )
      return true;
  }
  return false;
}

function hideThemesSection(component: RenderableNode) {
  if (!hasChildren(component)) return false;

  for (let index = 0; index < component.children.length; index += 1) {
    const child = component.children[index]!;
    const firstLine = renderedText(child)
      .split("\n")
      .find((line) => line.trim())
      ?.trim();

    if (firstLine === "[Themes]") {
      const removeCount =
        component.children[index + 1] &&
        renderedText(component.children[index + 1]!).trim() === ""
          ? 2
          : 1;
      component.children.splice(index, removeCount);
      component.invalidate();
      return true;
    }

    if (hideThemesSection(child)) return true;
  }

  return false;
}

function formatTokens(tokens: number) {
  if (tokens < 1_000) return `${tokens}`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}m`;
}

export function formatDirectory(cwd: string) {
  const home = homedir();
  if (cwd === home) return "~";
  const display = cwd.startsWith(`${home}/`) ? `~/${relative(home, cwd)}` : cwd;
  return sanitizeTerminalLabel(display);
}

function center(text: string, width: number) {
  const padding = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
  return truncateToWidth(`${" ".repeat(padding)}${text}`, width);
}

function columns(left: string, right: string, width: number) {
  if (!right) return truncateToWidth(left, width);

  const naturalGap = width - visibleWidth(left) - visibleWidth(right);
  if (naturalGap >= 1) return `${left}${" ".repeat(naturalGap)}${right}`;

  const leftWidth = Math.max(1, Math.floor(width * 0.45));
  const rightWidth = Math.max(1, width - leftWidth - 1);
  const fittedLeft = truncateToWidth(left, leftWidth);
  const fittedRight = truncateToWidth(right, rightWidth);
  const gap = Math.max(
    1,
    width - visibleWidth(fittedLeft) - visibleWidth(fittedRight),
  );
  return truncateToWidth(
    `${fittedLeft}${" ".repeat(gap)}${fittedRight}`,
    width,
  );
}

export default function uiCustomization(pi: ExtensionAPI) {
  let title = "pi";
  let modelInfo = emptyModelInfoState();
  let gitInfo = emptyGitInfoState();
  let requestRender: (() => void) | undefined;
  let activeTui: DashboardTui | undefined;
  let resourceCustomizationTimers: Array<ReturnType<typeof setTimeout>> = [];

  const stopModelListener = pi.events.on(MODEL_INFO_CHANNEL, (value) => {
    if (!isModelInfoState(value)) return;
    modelInfo = value;
    requestRender?.();
  });

  const stopGitListener = pi.events.on(GIT_INFO_CHANNEL, (value) => {
    if (!isGitInfoState(value)) return;
    gitInfo = value;
    requestRender?.();
  });

  function scheduleResourceCustomization(
    tui: DashboardTui,
    ctx: ExtensionContext,
  ) {
    for (const timer of resourceCustomizationTimers) clearTimeout(timer);
    resourceCustomizationTimers = [];

    for (const delay of [0, 50, 250, 1_000]) {
      resourceCustomizationTimers.push(
        setTimeout(() => {
          const modelInvocableNames = extractModelInvocableSkillNames(
            ctx.getSystemPrompt(),
          );
          const skillsChanged = categorizeSkillsSection(
            tui,
            modelInvocableNames,
            (text) => ctx.ui.theme.fg("mdHeading", text),
            (text) => ctx.ui.theme.fg("dim", text),
          );
          if (skillsChanged || hideThemesSection(tui)) {
            tui.requestRender(true);
          }
        }, delay),
      );
    }
  }

  function install(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;

    ctx.ui.setHeader((tui) => {
      activeTui = tui;
      requestRender = () => tui.requestRender();
      scheduleResourceCustomization(tui, ctx);

      return {
        render(width: number) {
          const art = TITLE_LINES.map((line, row) =>
            center(gradientText(line, row * 0.045), width),
          );
          const subtitle = center(
            `${BOLD}${gradientText(title, 0.18)}${RESET}`,
            width,
          );
          return ["", ...art, subtitle, ""];
        },
        invalidate() {},
      };
    });

    ctx.ui.setFooter((tui, theme, footerData: ReadonlyFooterDataProvider) => {
      requestRender = () => tui.requestRender();

      return {
        invalidate() {},
        render(width: number) {
          const directory = theme.fg("text", formatDirectory(ctx.cwd));
          const fileLabel = gitInfo.changedFiles === 1 ? "file" : "files";
          let git = gitInfo.branch
            ? `${gitInfo.branch} · ${gitInfo.changedFiles} ${fileLabel} changed`
            : "";

          if (gitInfo.pullRequest) {
            const prLabel = `PR #${gitInfo.pullRequest.number}`;
            const linkedPr = getCapabilities().hyperlinks
              ? hyperlink(prLabel, gitInfo.pullRequest.url)
              : prLabel;
            git += ` · ${linkedPr}`;
          }

          const contextPercent =
            modelInfo.contextPercent === null
              ? "?"
              : `${Math.round(modelInfo.contextPercent)}`;
          const contextWindow =
            modelInfo.contextWindow > 0
              ? formatTokens(modelInfo.contextWindow)
              : "?";
          const tps =
            modelInfo.tokensPerSecond === null
              ? "— tok/s"
              : `${Math.round(modelInfo.tokensPerSecond)} tok/s`;
          const contextUsage = `${contextPercent}%/${contextWindow}`;
          const styledContextUsage =
            modelInfo.contextTokens !== null &&
            modelInfo.contextTokens > CONTEXT_DANGER_TOKENS
              ? theme.fg("error", contextUsage)
              : modelInfo.contextTokens !== null &&
                  modelInfo.contextTokens >= CONTEXT_WARNING_TOKENS
                ? theme.fg("warning", contextUsage)
                : theme.fg("muted", contextUsage);
          const usage = `${styledContextUsage}${theme.fg(
            "muted",
            ` · $${modelInfo.cost.toFixed(2)} · ${tps}`,
          )}`;
          const model = modelInfo.provider
            ? `${modelInfo.provider}/${modelInfo.modelId} · ${modelInfo.thinking}`
            : modelInfo.modelId;

          const lines = [
            columns(directory, theme.fg("muted", model), width),
            columns(usage, theme.fg("muted", git), width),
          ];

          // Extension statuses render after the two dashboard lines, one per row.
          const statuses = footerData.getExtensionStatuses();
          const statusLines = Array.from(statuses.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .flatMap(([, text]) => text.split("\n"));
          for (const statusLine of statusLines) {
            lines.push(
              truncateToWidth(statusLine, width, theme.fg("dim", "...")),
            );
          }

          return lines;
        },
      };
    });

    ctx.ui.setTitle(`pi · ${title}`);
    pi.events.emit(REFRESH_CHANNEL, undefined);
  }

  pi.on("session_start", (_event, ctx) => {
    title = formatDirectory(ctx.cwd);
    modelInfo = emptyModelInfoState();
    gitInfo = emptyGitInfoState();
    install(ctx);
  });

  pi.on("resources_discover", (_event, ctx) => {
    if (activeTui) scheduleResourceCustomization(activeTui, ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopModelListener();
    stopGitListener();
    for (const timer of resourceCustomizationTimers) clearTimeout(timer);
    resourceCustomizationTimers = [];
    activeTui = undefined;
    requestRender = undefined;
    if (ctx.mode === "tui") {
      ctx.ui.setHeader(undefined);
      ctx.ui.setFooter(undefined);
    }
  });
}
