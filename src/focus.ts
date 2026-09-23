/**
 * focus.ts — working-memory scratchpad (cíngulate-slice style continuity).
 *
 * Seamless pi integration:
 * - promptSnippet + promptGuidelines → shows in Available tools / Guidelines like read/bash
 * - renderCall/renderResult → themed Text UI (collapsed/expanded), same shell as built-ins
 * - signal abort → respects AbortSignal like every native tool
 * - branch-safe state via tool-result details (todo.ts pattern)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { fmtAge, scanToolDetails, truncate } from "./common";

export interface FocusState {
  goal?: string;
  files: string[];
  acceptance?: string;
  blocker?: string;
  status: "working" | "blocked" | "done";
  updatedAt: number;
}

const EMPTY: FocusState = { files: [], status: "working", updatedAt: 0 };

// Module-level working copy — branch-safe: rebuilt from branch on session events.
let state: FocusState = { ...EMPTY };

export function getFocusLine(): string | null {
  if (!state.goal && !state.files.length) return null;
  const goal = state.goal ?? "(no goal set)";
  const files = state.files.length ? ` files:[${state.files.join(",")}]` : "";
  const acc = state.acceptance ? ` acceptance:${state.acceptance}` : "";
  const blocker = state.blocker ? ` blocker:${state.blocker}` : "";
  const status = state.status !== "working" ? ` status:${state.status}` : "";
  return `[smart-pi focus] ${goal}${files}${acc}${blocker}${status}`;
}

export function rebuildFocus(ctx: ExtensionContext): void {
  const details = scanToolDetails(ctx, "focus").at(-1);
  state = { ...EMPTY, ...(normalize(details) ?? {}) };
}

function normalize(d: any): FocusState | undefined {
  if (!d || typeof d !== "object" || !("state" in d)) return undefined;
  const s = d.state as Partial<FocusState> | undefined;
  if (!s || typeof s !== "object") return undefined;
  return {
    goal: typeof s.goal === "string" ? truncate(s.goal, 200) : undefined,
    files: Array.isArray(s.files) ? s.files.map(String).slice(0, 20) : [],
    acceptance: typeof s.acceptance === "string" ? truncate(s.acceptance, 300) : undefined,
    blocker: typeof s.blocker === "string" ? truncate(s.blocker, 200) : undefined,
    status: s.status === "blocked" || s.status === "done" ? s.status : "working",
    updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : Date.now(),
  };
}

function render(s: FocusState): string {
  if (!s.goal && !s.files.length) return "focus: (empty) — set goal/files/acceptance to keep the agent on track";
  const lines = [
    `focus: ${s.goal ?? "—"}`,
    `status: ${s.status}${s.updatedAt ? ` (${fmtAge(s.updatedAt)})` : ""}`,
  ];
  if (s.files.length) lines.push(`files: ${s.files.join(", ")}`);
  if (s.acceptance) lines.push(`acceptance: ${s.acceptance}`);
  if (s.blocker) lines.push(`blocker: ${s.blocker}`);
  return lines.join("\n");
}

const FocusParams = Type.Object({
  goal: Type.Optional(Type.String({ description: "Current task goal, one line (replaces existing)" })),
  files: Type.Optional(Type.Array(Type.String(), { description: "Files in scope (merged with existing)" })),
  acceptance: Type.Optional(Type.String({ description: "How success will be verified" })),
  blocker: Type.Optional(Type.String({ description: "What is blocking progress (sets status=blocked)" })),
  status: Type.Optional(Type.String({ description: "working | blocked | done" })),
  clear: Type.Optional(Type.Boolean({ description: "Clear the focus scratchpad" })),
});

export function registerFocusTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "focus",
    label: "focus",
    description:
      "Working-memory scratchpad for the CURRENT micro-task: goal, files in scope, acceptance criteria, blocker. Survives compaction (auto-injected into the compaction summary). Helps the agent keep one coherent thread across turns. Call at task start; update as state changes; focus {clear:true} when done. Call with no params to report.",
    promptSnippet: "Focus — working memory for the current micro-task",
    promptGuidelines: [
      "Call focus at task start with goal + files + acceptance; update as you progress.",
      "Focus survives compaction automatically — no need to re-state it after /compact.",
    ],
    parameters: FocusParams,
    async execute(_id, params, signal, _onUpdate, _ctx) {
      if (signal?.aborted) throw new Error("Operation aborted");
      if (params.clear) {
        state = { ...EMPTY };
        return {
          content: [{ type: "text", text: "Focus cleared." }],
          details: { action: "clear", state: { ...state } },
        };
      }
      const prev = { ...state };
      const next: FocusState = {
        goal: params.goal !== undefined ? truncate(params.goal, 200) : state.goal,
        files: params.files !== undefined ? [...new Set([...state.files, ...params.files.map(String)])].slice(0, 20) : state.files,
        acceptance: params.acceptance !== undefined ? truncate(params.acceptance, 300) : state.acceptance,
        blocker: params.blocker !== undefined ? truncate(params.blocker, 200) : params.blocker === "" ? undefined : state.blocker,
        status:
          params.status === "blocked" || params.status === "done" || params.status === "working"
            ? params.status
            : params.blocker
              ? "blocked"
              : state.status,
        updatedAt: Date.now(),
      };
      if (params.blocker && params.blocker.trim()) next.status = "blocked";
      state = next;
      const action = !prev.goal && !prev.files.length ? "set" : prev.blocker && !next.blocker ? "cleared-blocker" : "update";
      return {
        content: [{ type: "text", text: render(next) }],
        details: { action, state: { ...next }, prev: prev.goal ? prev.goal.slice(0, 80) : undefined },
      };
    },
    renderCall(args, theme, _ctx) {
      if (args.clear) return new Text(theme.fg("toolTitle", theme.bold("focus")) + theme.fg("muted", " clear"), 0, 0);
      if (!args.goal && !args.files?.length && !args.acceptance && !args.blocker && !args.status) {
        return new Text(theme.fg("toolTitle", theme.bold("focus")) + theme.fg("dim", " — report"), 0, 0);
      }
      let text = theme.fg("toolTitle", theme.bold("focus"));
      if (args.goal) text += ` ${theme.fg("accent", `"${args.goal.slice(0, 60)}"`)}`;
      if (args.files?.length) text += ` ${theme.fg("dim", `files:${args.files.slice(0, 3).join(",")}`)}`;
      if (args.blocker) text += ` ${theme.fg("warning", `blocker:${args.blocker.slice(0, 30)}`)}`;
      if (args.status) text += ` ${theme.fg("muted", args.status)}`;
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded }, theme, _ctx) {
      const details = result.details as { action?: string; state?: FocusState } | undefined;
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      if (details?.action === "clear") return new Text(theme.fg("success", "✓ Focus cleared"), 0, 0);
      const s = details?.state;
      if (!s) return new Text(theme.fg("toolOutput", text), 0, 0);
      const statusColor = s.status === "blocked" ? "warning" : s.status === "done" ? "success" : "muted";
      let out = s.goal ? theme.fg("accent", s.goal) : theme.fg("dim", "(no goal)");
      out += `  ${theme.fg(statusColor as any, s.status)} ${theme.fg("dim", fmtAge(s.updatedAt))}`;
      if (s.files.length) out += `\n${theme.fg("muted", "files:")} ${theme.fg("toolOutput", s.files.join(", "))}`;
      if (expanded) {
        if (s.acceptance) out += `\n${theme.fg("muted", "acceptance:")} ${theme.fg("toolOutput", s.acceptance)}`;
        if (s.blocker) out += `\n${theme.fg("warning", "blocker:")} ${theme.fg("toolOutput", s.blocker)}`;
      } else if (s.blocker) {
        out += `\n${theme.fg("warning", "blocker:")} ${theme.fg("dim", s.blocker.slice(0, 80))}`;
      }
      return new Text(out, 0, 0);
    },
  });
}
