/**
 * init.ts — /smart-init command: opt-in bootstrap that runs the 3 init calls sequentially.
 *
 * No auto-trigger via events — strictly user-initiated.
 * Sequential: 1) project-intel (cached if available), 2) context-budget snapshot, 3) focus set.
 *
 * Reuses the same helpers as the tools so branch-state stays consistent
 * (smart:intel entry + focus module state), so /smart and subsequent agent turns see it.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { budgetAdvice, budgetTier } from "./budget";
import { scanEntries } from "./common";
import { getFocusState, setFocusState } from "./focus";
import { discover, getCachedProfile, setCachedProfile } from "./intel";

function parseInitArgs(raw: string): { goal?: string; acceptance?: string; files?: string[] } {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  // supported separators: " -- ", " | ", " :: ", " // "
  const seps = [" -- ", " | ", " :: ", " // ", " --", "|", "::"];
  for (const sep of seps) {
    if (trimmed.includes(sep)) {
      const parts = trimmed.split(sep);
      const goal = parts[0]?.trim() || undefined;
      const acceptance = parts.slice(1).join(sep).trim() || undefined;
      return { goal, acceptance };
    }
  }
  // fallback: whole string is goal; if it looks like "goal. acceptance is X" try split on ". "
  if (trimmed.length > 80 && trimmed.includes(". ")) {
    const idx = trimmed.indexOf(". ");
    const goal = trimmed.slice(0, idx).trim();
    const acceptance = trimmed.slice(idx + 2).trim();
    if (goal.length > 10 && acceptance.length > 5) return { goal, acceptance };
  }
  return { goal: trimmed };
}

export function registerInitCommand(pi: ExtensionAPI): void {
  pi.registerCommand("smart-init", {
    description: "Bootstrap smart-pi for this task: runs project-intel (cached), budget check, and sets focus. Usage: /smart-init <goal> [-- <acceptance>]",
    handler: async (args, ctx: ExtensionContext & { ui: any }) => {
      const parsed = parseInitArgs(args ?? "");
      let goal = parsed.goal;
      let acceptance = parsed.acceptance;

      // Prompt for goal if not provided and UI available
      if (!goal) {
        if (ctx.hasUI && ctx.mode === "tui") {
          try {
            const input = await ctx.ui.input("smart-init — task goal", "e.g. add login flow with tests");
            if (input && input.trim()) goal = input.trim();
            // if input contains separator, re-parse
            if (goal && (goal.includes(" -- ") || goal.includes(" | "))) {
              const reparsed = parseInitArgs(goal);
              goal = reparsed.goal;
              acceptance = reparsed.acceptance ?? acceptance;
            }
            // optionally ask for acceptance if not provided
            if (goal && !acceptance && ctx.hasUI) {
              const accInput = await ctx.ui.input("acceptance (how will you verify?)", "e.g. npm run typecheck && npm test passes");
              if (accInput && accInput.trim()) acceptance = accInput.trim();
            }
          } catch {
            /* input cancelled */
          }
        }
        if (!goal) {
          ctx.ui?.notify?.("smart-init: goal is required. Usage: /smart-init <goal> [-- <acceptance>]\nExample: /smart-init \"add auth flow\" -- \"npm run typecheck passes\"", "warning");
          return;
        }
      }

      if (ctx.signal?.aborted) return;

      // 1) project-intel — 0 reads if cached for this cwd
      let intelSource: "cache" | "fresh" = "cache";
      let profile = getCachedProfile();
      // also check durable entry in branch (in case module cache was cleared)
      if (!profile || profile.cwd !== ctx.cwd) {
        const branchIntel = scanEntries(ctx, "smart:intel").at(-1) as any;
        if (branchIntel && branchIntel.cwd === ctx.cwd && branchIntel.scannedAt) {
          profile = branchIntel;
          setCachedProfile(profile);
        }
      }
      if (!profile || profile.cwd !== ctx.cwd) {
        try {
          ctx.ui?.setStatus?.("smart-init", "scanning project…");
          // use discover directly so we can show progress
          const fresh = await discover(ctx.cwd, ctx.signal, (msg) => {
            try {
              ctx.ui?.setStatus?.("smart-init", msg);
            } catch {}
          });
          profile = fresh;
          setCachedProfile(profile);
          try {
            (pi as any).appendEntry?.("smart:intel", profile);
          } catch {}
          intelSource = "fresh";
        } catch (e: any) {
          ctx.ui?.setStatus?.("smart-init", undefined);
          ctx.ui?.notify?.(`smart-init intel failed: ${e?.message ?? String(e)}`, "error");
          return;
        } finally {
          ctx.ui?.setStatus?.("smart-init", undefined);
        }
        if (ctx.signal?.aborted) return;
      }

      // 2) context-budget snapshot (read-only, no write)
      let budgetLine = "unknown";
      let budgetPct: number | null = null;
      try {
        const u = ctx.getContextUsage?.();
        if (u) {
          const rawPct = (u as any).percent;
          budgetPct = rawPct != null ? Math.round(rawPct) : u.tokens != null && u.contextWindow ? Math.round((u.tokens / u.contextWindow) * 100) : null;
          budgetLine = `${budgetPct === null ? "unknown" : budgetPct + "%"} ${budgetTier(budgetPct)} — ${budgetAdvice(budgetPct)}`;
        } else {
          budgetLine = "unknown (post-compaction or no model yet)";
        }
      } catch {
        budgetLine = "n/a";
      }

      // 3) focus — branch-safe via module state + durable entry (same as focus tool's toolResult path)
      const focusState = setFocusState({ goal, acceptance, status: "working" });
      try {
        (pi as any).appendEntry?.("smart:focus", { state: focusState });
      } catch {}
      // agent sees focus via getFocusLine() on next turn and via scanEntries fallback after tree navigation

      const intelLabel = profile.name ?? profile.cwd.split(/[\\/]/).pop() ?? "unknown";
      const intelLangNote = profile.lang === "unknown" ? "(no package.json / pyproject / Cargo etc. detected — empty folder?)" : `(${profile.lang})`;
      const lines: string[] = [
        "smart-init ready — 3 checks done",
        `intel: ${intelLabel} ${intelLangNote} ${intelSource === "cache" ? "· cached" : "· fresh"}${profile.gitBranch ? ` — git:${profile.gitBranch}` : " — no git"}`,
        `       test: ${profile.testCmd ?? "not detected"} | lint: ${profile.lintCmd ?? "not detected"} | build: ${profile.buildCmd ?? "not detected"}`,
        `budget: ${budgetLine}`,
        `focus: ${goal}${acceptance ? ` → acceptance: ${acceptance}` : ""}  [${focusState.status}]`,
        "",
        "starting agent on this task…",
      ];
      if (profile.lang === "unknown") lines.push("hint: intel is cached as 'unknown' because no project files found — after you add code, run /smart-init again or project-intel {refresh:true}");
      if (intelSource === "fresh") lines.push("(intel freshly scanned — next calls are 0 reads)");

      ctx.ui?.notify?.(lines.join("\n"), "info");

      // Auto-trigger the agent so the user sees progress immediately (the "nothing happens" fix)
      // The focus + intel are already durable, so the agent resumes with full context.
      if (ctx.signal?.aborted) return;
      const autoPrompt = [
        `Task: ${goal}`,
        acceptance ? `Acceptance: ${acceptance}` : null,
        "",
        `Context (already prepared by /smart-init):`,
        `- project: ${intelLabel} ${intelLangNote}${profile.gitBranch ? ` git:${profile.gitBranch}` : ""} — test: ${profile.testCmd ?? "not detected"}`,
        `- budget: ${budgetLine}`,
        `- focus is set — keep it updated via focus tool; verify before done`,
        "",
        `Proceed stepwise. If no git repo, init it first. Then enhance UI/UX, verify with ${profile.testCmd ?? profile.lintCmd ?? "appropriate check"}, and commit. Keep edits narrow and batch tool calls.`,
      ]
        .filter(Boolean)
        .join("\n");

      try {
        if (!ctx.isIdle?.()) {
          pi.sendUserMessage(autoPrompt, { deliverAs: "followUp" } as any);
        } else {
          pi.sendUserMessage(autoPrompt);
        }
      } catch (e: any) {
        // fallback: at least tell user how to trigger manually
        ctx.ui?.notify?.(`Agent not auto-started (${e?.message ?? String(e)}). Just prompt: "${goal}"`, "warning");
      }
    },
  });
}
