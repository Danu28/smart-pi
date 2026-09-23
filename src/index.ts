/**
 * smart-pi — a pi extension that makes the coding agent smarter at runtime.
 *
 * Priority order baked into every decision:
 *   1. agent-friendly   — every tool returns compact, actionable text the model
 *                         can act on without re-reading files.
 *   2. high-productivity — read-once intel, focus continuity, verify closure.
 *   3. user-friendly    — /smart status command; no mode switches to manage.
 *   4. cost-efficient   — all 4 tools registered UPFRONT (KV-cache-friendly,
 *                         no dynamic activation that invalidates the prefix);
 *                         the only injected text is (a) one focus line inside
 *                         a compaction summary (zero steady-state cost) and
 *                         (b) a one-line warning only when >=90% context full.
 *
 * 5-step QDS applied: Question → Delete → Simplify → Accelerate → Automate.
 *    - Question: what makes pi dumb? (a) forgets the thread after compaction,
 *      (b) blind to context usage, (c) re-discovers project facts every turn,
 *      (d) claims success without checking. Four tools, one per gap.
 *    - Delete: no memory (pi-brain owns that), no re-planning, no injected
 *      flow notes every turn, no custom TUI components.
 *    - Simplify: one tool per gap, plain params, branch-safe state via
 *      tool-result details (reference todo.ts pattern).
 *    - Accelerate: intel cache = 0 reads after first scan; verify tail-cuts
 *      logs; budget ticks trend in details.
 *    - Automate: focus rides compaction summary; budget warning only at >=90%.
 *
 * Integrates cleanly with pi-brain: pi-brain = long-term memory + strict
 * workflow; smart-pi = in-session runtime intelligence.
 */

import type { ExtensionAPI, ExtensionContext, ContextEvent } from "@earendil-works/pi-coding-agent";
import { budgetGuard, registerBudgetTool, resetBudgetFlags } from "./budget";
import { fmtAge, lastToolDetails, scanEntries, scanToolDetails, truncate } from "./common";
import { getFocusLine, rebuildFocus, registerFocusTool } from "./focus";
import { rebuildIntel, registerIntelTool } from "./intel";
import { registerVerifyTool } from "./verify";

export default function (pi: ExtensionAPI) {
  // ---- tools: registered upfront so the initial tool set is stable ----
  registerFocusTool(pi); //        working-memory scratchpad (compaction continuity)
  registerBudgetTool(pi); //       context awareness + optional compact()
  registerIntelTool(pi); //        read-once project profile (scripts/test/lint/build)
  registerVerifyTool(pi); //       structured PASS/FAIL for checks

  // ---- /smart status ----
  pi.registerCommand("smart", {
    description: "smart-pi status: focus, context usage, project intel, last verify",
    handler: async (args, ctx) => {
      const lines: string[] = ["smart-pi" + (args ? ` [${args}]` : "")];

      const focusLine = getFocusLine();
      lines.push(focusLine ? `focus: ${focusLine.replace(/^\[smart-pi focus\] /, "")}` : "focus: (none set)");

      let usage = "n/a";
      try {
        const u = ctx.getContextUsage?.();
        if (u) usage = u.percent === null ? "unknown (post-compaction)" : `${u.percent}% (${u.tokens ?? "?"} tokens / ${u.contextWindow} window)`;
      } catch {
        /* ignore */
      }
      lines.push(`context: ${usage}`);

      const intel = lastIntel(ctx);
      lines.push(`intel: ${intel ? `${intel.name ?? intel.cwd} (${intel.lang}) — test: ${intel.testCmd ?? "?"} — ${fmtAge(intel.scannedAt)}` : "not scanned — ask the agent to call project-intel"}`);

      const v = lastToolDetails(ctx, "verify") as { record?: { ok: boolean; code: number; command: string; ts: number } } | undefined;
      lines.push(`last verify: ${v?.record ? `${v.record.ok ? "PASS" : "FAIL"} (exit ${v.record.code}) — ${v.record.command} — ${fmtAge(v.record.ts)}` : "none yet — ask the agent to call verify"}`);

      ctx.ui?.notify?.(lines.join("\n"), "info");
    },
  });

  // ---- lifecycle: rebuild branch-safe state ----
  pi.on("session_start", async (_ev, ctx) => {
    resetBudgetFlags();
    rebuildFocus(ctx);
    rebuildIntel(ctx);
  });
  pi.on("session_tree", async (_ev, ctx) => {
    rebuildFocus(ctx);
  });
  pi.on("session_shutdown" as any, async () => {
    // nothing to flush — state is branch-durable via tool-result details + entries
  });

  // ---- Automate: focus rides the compaction summary (zero steady-state cost) ----
  pi.on("session_before_compact" as any, async (ev: any) => {
    const focusLine = getFocusLine();
    if (!focusLine) return undefined;
    const summary = ev?.summary ?? "";
    const prefix = `${focusLine}\n\n`;
    return { summary: summary ? `${prefix}${summary}` : prefix.trim() } as any;
  });

  // ---- Automate: budget warning only when critically full (>=90%), once per high period ----
  pi.on("context" as any, async (ev: ContextEvent, ctx: ExtensionContext) => {
    let pct: number | null = null;
    try {
      const u = ctx.getContextUsage?.();
      if (u) pct = u.percent ?? (u.tokens != null && u.contextWindow ? Math.round((u.tokens / u.contextWindow) * 100) : null);
    } catch {
      /* ignore */
    }
    const msgs: any[] = ev?.messages ?? [];
    const res = budgetGuard(msgs, pct);
    if (res.changed) return { messages: res.messages } as any;
    return undefined;
  });
}

// local helper: newest intel profile from branch entries without importing internals
function lastIntel(ctx: ExtensionContext) {
  const all = scanEntries(ctx, "smart:intel");
  const last = all.at(-1) as any;
  if (last && typeof last === "object") {
    return {
      name: typeof last.name === "string" ? last.name : undefined,
      cwd: typeof last.cwd === "string" ? last.cwd : ctx.cwd,
      lang: typeof last.lang === "string" ? last.lang : "unknown",
      testCmd: typeof last.testCmd === "string" ? last.testCmd : undefined,
      scannedAt: typeof last.scannedAt === "number" ? last.scannedAt : 0,
    };
  }
  return undefined;
}