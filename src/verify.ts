/**
 * verify.ts — verify: run a check; return structured PASS/FAIL.
 *
 * QDS:
 *  - Question: models call bash for checks but frequently forget the exit code
 *    or drown in 50KB of logs. A check that always returns PASS/FAIL + exit
 *    code + the ERROR TAIL closes the loop reliably.
 *  - Delete: no test-runner integration, no watch mode — one command, one
 *    result. (Batch parallelism still comes free: pi runs tools in one message
 *    in parallel, so call verify multiple times in one turn.)
 *  - Simplify: command + optional cwd/timeout; history (last 3) rides details.
 *  - Accelerate: output is tail-truncated to the error region; exit code is
 *    always surfaced; history lets the agent see pass→fail transitions.
 *  - Automate: nothing injected; on-demand. Composes with project-intel
 *    (use its testCmd) and focus (its acceptance criteria).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fmtAge, runCmd, scanToolDetails, tail, truncate, VERIFY_TAIL_LINES } from "./common";

interface VerifyRecord {
  ts: number;
  command: string;
  ok: boolean;
  code: number;
  timedOut: boolean;
}

const VerifyParams = Type.Object({
  command: Type.String({ description: "Shell command to run (e.g. 'npm test' or the testCmd from project-intel)" }),
  cwd: Type.Optional(Type.String({ description: "Working directory (default: project root)" })),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default 120, max 600)", minimum: 1, maximum: 600 })),
});

export function registerVerifyTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "verify",
    label: "Verify",
    description:
      "Run a check command and return a structured verdict: PASS/FAIL/TIMEOUT with exit code and the last error lines. Use for tests, lint, typecheck, builds — never claim success without a verify. History of the last 3 checks rides in details.",
    parameters: VerifyParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const command = String(params.command).trim();
      if (!command) {
        return { content: [{ type: "text", text: "verify: command is required." }], details: { error: "empty command" } };
      }
      const timeoutS = Math.min(params.timeout ?? 120, 600);
      const start = Date.now();
      const res = await runCmd(command, {
        cwd: params.cwd ? String(params.cwd).trim() : ctx.cwd,
        timeoutMs: timeoutS * 1000,
      });
      const elapsed = Math.round((Date.now() - start) / 1000);
      const record: VerifyRecord = { ts: Date.now(), command, ok: res.ok, code: res.code, timedOut: res.timedOut };
      const history = [...(scanToolDetails(ctx, "verify").at(-1)?.history ?? []), record].slice(-3);

      const verdict = res.timedOut ? "TIMEOUT" : res.ok ? "PASS" : "FAIL";
      const body = res.timedOut
        ? `command did not finish within ${timeoutS}s — it was killed. Re-run with a larger timeout, or check for hanging processes.`
        : res.ok
          ? truncate(res.stdout.trim() || res.stderr.trim() || "(no output)", 600)
          : truncate(tail({ stdout: res.stdout, stderr: res.stderr }, VERIFY_TAIL_LINES), 1600);
      const text = [
        `verify: ${verdict} (exit ${res.code}) in ${elapsed}s — ${command}`,
        body,
        res.ok ? "→ safe to proceed; update focus acceptance if it changed." : "→ fix the failing point above, then re-run verify. Do not move on while FAIL.",
      ].join("\n");
      return {
        content: [{ type: "text", text }],
        details: { record, history: history.map((h) => ({ ...h, age: fmtAge(h.ts) })), source: "run" },
      };
    },
  });
}