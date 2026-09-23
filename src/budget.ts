/**
 * budget.ts — context-budget awareness tool.
 *
 * QDS:
 *  - Question: context overflow is the #1 cost killer (aborted turn → retry →
 *    compaction). The agent has zero visibility into context usage today.
 *  - Delete: no history persistence, no UI — one tool + one 1-line guard.
 *  - Simplify: reads ctx.getContextUsage(), returns tokens/window/percent with
 *    a tiered recommendation. Optional compact:true fires ctx.compact().
 *  - Accelerate: trend (last 5 samples) lives in tool-result details, so the
 *    agent can see direction without extra calls.
 *  - Automate: a single-line steering note is appended to the next request
 *    ONLY when usage >= BUDGET_WARN_PCT (default 90), once per high-water
 *    period. Rare, tiny, and prevents overflow retries.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BUDGET_CLEAR_PCT, BUDGET_WARN_PCT, scanToolDetails } from "./common";

export interface BudgetSample {
  ts: number;
  tokens: number | null;
  window: number;
  percent: number | null;
}

const HISTORY_MAX = 5;
let warned = false; // armed once per high-water period
export function resetBudgetFlags(): void {
  warned = false;
}

export function budgetTier(percent: number | null): string {
  if (percent === null) return "unknown";
  if (percent < 50) return "clear";
  if (percent < 70) return "moderate";
  if (percent < BUDGET_WARN_PCT) return "getting-full";
  return "critical";
}

export function budgetAdvice(percent: number | null): string {
  switch (budgetTier(percent)) {
    case "clear":
      return "plenty of room — proceed normally. Still batch parallel tool calls to save round-trips.";
    case "moderate":
      return "moderate — batch reads, avoid re-reading files you already have, prefer narrow edits.";
    case "getting-full":
      return "getting full — finish the current deliverable, avoid large outputs (no full-file dumps), prefer edit over write.";
    case "critical":
      return "CRITICAL — stop producing large content now. Complete the current edit, run verify, then call context-budget {compact:true} or ask the user to /compact.";
    default:
      return "context usage unknown (e.g. right after compaction) — expect the next response to be smaller.";
  }
}

/** Inject a one-line warning before an LLM request when usage is critically high. */
export function maybeWarn(messages: any[]): { changed: boolean; messages: any[] } {
  // usage is read by the caller (index.ts) because ctx is not reachable here;
  // this function only appends the note to the last user message.
  const last = lastUserMessage(messages);
  if (!last) return { changed: false, messages };
  const note = "\n\n[smart-pi] context is critically full — wrap up the current task, avoid large outputs, prefer narrow edits; consider context-budget {compact:true}.";
  if (typeof last.msg.content === "string") {
    last.msg.content += note;
  } else if (Array.isArray(last.msg.content)) {
    last.msg.content.push({ type: "text", text: note });
  }
  return { changed: true, messages };
}

export function lastUserMessage(msgs: any[]): { msg: any; text: string } | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string") return { msg: m, text: c };
    if (Array.isArray(c)) {
      for (let j = c.length - 1; j >= 0; j--) {
        const b = c[j];
        if (b && typeof b.text === "string") return { msg: m, text: b.text };
      }
    }
    return { msg: m, text: "" };
  }
  return null;
}

const BudgetParams = Type.Object({
  compact: Type.Optional(Type.Boolean({ description: "Ask pi to compact the context now (fire-and-forget)" })),
});

export function registerBudgetTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "context-budget",
    label: "Context Budget",
    description:
      "Report current context usage (tokens / window / percent) with tiered advice (clear ≤50, moderate ≤70, getting-full <90, critical ≥90). Use before large reads/writes; call context-budget {compact:true} to compact. Tick the trend in details.",
    parameters: BudgetParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const usage = ctx.getContextUsage?.() ?? undefined;
      const sample: BudgetSample = {
        ts: Date.now(),
        tokens: usage?.tokens ?? null,
        window: usage?.contextWindow ?? 0,
        percent: usage?.percent ?? (usage?.tokens != null && usage.contextWindow ? Math.round((usage.tokens / usage.contextWindow) * 100) : null),
      };
      const history = [...(scanToolDetails(ctx, "context-budget").at(-1)?.history ?? []), sample]
        .slice(-HISTORY_MAX);
      const pct = sample.percent;
      // re-arm warning once usage drops back under the clear threshold
      if (pct !== null && pct < BUDGET_CLEAR_PCT) warned = false;

      const trend = history.length > 1 ? ` ${history.map((h: BudgetSample) => h.percent ?? "?").join("→")}` : "";
      const text = [
        `context: ${pct === null ? "unknown" : `${pct}%`}${trend}`,
        `tokens: ${sample.tokens ?? "n/a"} / window ${sample.window || "n/a"}`,
        `tier: ${budgetTier(pct)}`,
        `advice: ${budgetAdvice(pct)}`,
      ].join("\n");

      if (params.compact) {
        try {
          ctx.compact?.();
          return {
            content: [
              { type: "text", text: `${text}\n\nCompaction requested — pi will compact and the next turn resumes from the summary (your focus line is preserved).` },
            ],
            details: { usage: sample, history, compactRequested: true },
          };
        } catch {
          return {
            content: [{ type: "text", text: `${text}\n\nCompaction request failed (see runtime).` }],
            details: { usage: sample, history, compactRequested: false, error: "compact threw" },
          };
        }
      }
      return { content: [{ type: "text", text }], details: { usage: sample, history, tier: budgetTier(pct) } };
    },
  });
}

/** Called from the `context` event when usage is critical — appends note once. */
export function budgetGuard(messages: any[], pct: number | null): { changed: boolean; messages: any[] } {
  if (pct === null) return { changed: false, messages };
  if (pct >= BUDGET_WARN_PCT && !warned) {
    warned = true;
    return maybeWarn(messages);
  }
  if (pct < BUDGET_CLEAR_PCT) warned = false;
  return { changed: false, messages };
}

export function isBudgetWarned(): boolean {
  return warned;
}