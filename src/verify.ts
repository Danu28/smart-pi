/**
 * verify.ts — verify: run a check; return structured PASS/FAIL.
 *
 * Seamless pi integration:
 * - promptSnippet + promptGuidelines (like bash)
 * - renderCall/renderResult with bash-style shell rendering (prompt $, colored verdict)
 * - signal-abort (AbortSignal) + onUpdate streaming (throttled like bash tool)
 * - truncate tail via common.tail, same 40-line handling as before but themed
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
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
    label: "verify",
    description:
      "Run a check command and return a structured verdict: PASS/FAIL/TIMEOUT with exit code and the last error lines. Use for tests, lint, typecheck, builds — never claim success without a verify. History of the last 3 checks rides in details.",
    promptSnippet: "Verify — run a check and get PASS/FAIL + exit code",
    promptGuidelines: [
      "Never claim success without a verify. Use the testCmd from project-intel.",
      "On FAIL, fix the failing point from the last 40 error lines, then re-verify.",
    ],
    parameters: VerifyParams,
    async execute(_id, params, signal, onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Operation aborted");
      const command = String(params.command).trim();
      if (!command) {
        return { content: [{ type: "text", text: "verify: command is required." }], details: { error: "empty command" } };
      }
      const timeoutS = Math.min(params.timeout ?? 120, 600);
      const start = Date.now();

      // Stream a running notice like bash does (throttled)
      let lastUpdate = 0;
      const maybeUpdate = (text: string) => {
        const now = Date.now();
        if (now - lastUpdate < 100) return;
        lastUpdate = now;
        try {
          onUpdate?.({ content: [{ type: "text", text }], details: { record: undefined, history: [], source: "running" } } as any);
        } catch {}
      };
      maybeUpdate(`verify: running — ${command}`);

      // Support abort: runCmd doesn't natively take signal, so race it
      let res: Awaited<ReturnType<typeof runCmd>>;
      if (signal) {
        const abortPromise = new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("Operation aborted")), { once: true });
        });
        res = await Promise.race([
          runCmd(command, { cwd: params.cwd ? String(params.cwd).trim() : ctx.cwd, timeoutMs: timeoutS * 1000 }),
          abortPromise as Promise<any>,
        ]);
      } else {
        res = await runCmd(command, { cwd: params.cwd ? String(params.cwd).trim() : ctx.cwd, timeoutMs: timeoutS * 1000 });
      }

      if (signal?.aborted) throw new Error("Operation aborted");
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
    renderCall(args, theme, _ctx) {
      const cmd = args.command.length > 80 ? `${args.command.slice(0, 77)}…` : args.command;
      let text = theme.fg("toolTitle", theme.bold("$ ")) + theme.fg("accent", cmd);
      if (args.timeout) text += theme.fg("dim", ` (timeout ${args.timeout}s)`);
      if (args.cwd) text += theme.fg("dim", ` @ ${args.cwd}`);
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, _ctx) {
      if (isPartial) return new Text(theme.fg("warning", "Verifying…"), 0, 0);
      const txt = result.content[0]?.type === "text" ? result.content[0].text : "";
      const firstLine = txt.split("\n")[0] ?? "";
      const isPass = firstLine.includes("PASS");
      const isFail = firstLine.includes("FAIL");
      const isTimeout = firstLine.includes("TIMEOUT");
      let badge: string;
      if (isTimeout) badge = theme.fg("warning", "TIMEOUT");
      else if (isPass) badge = theme.fg("success", "PASS");
      else if (isFail) badge = theme.fg("error", "FAIL");
      else badge = theme.fg("muted", "verify");
      const codeMatch = firstLine.match(/exit (\d+)/);
      const code = codeMatch ? ` ${theme.fg("dim", `exit ${codeMatch[1]}`)}` : "";
      const timeMatch = firstLine.match(/in (\d+s)/);
      const time = timeMatch ? theme.fg("dim", ` ${timeMatch[1]}`) : "";
      let out = `${badge}${code}${time}  ${theme.fg("dim", firstLine.slice(firstLine.indexOf("—") + 1).trim().slice(0, 60))}`;
      if (expanded) {
        const body = txt.split("\n").slice(1, -1).join("\n").trim();
        if (body) {
          const lines = body.split("\n").slice(0, 20);
          out += `\n${lines.map((l) => (isFail || isTimeout ? theme.fg("toolOutput", l) : theme.fg("dim", l))).join("\n")}`;
          if (body.split("\n").length > 20) out += `\n${theme.fg("muted", "… more lines (model sees last 40)")}`;
        }
        const hint = txt.split("\n").at(-1);
        if (hint?.startsWith("→")) out += `\n${theme.fg(isPass ? "success" : "warning", hint)}`;
      } else if (isFail || isTimeout) {
        // collapsed: show last meaningful error line
        const bodyLines = txt.split("\n").slice(1, -1).filter(Boolean);
        const lastErr = bodyLines.at(-1);
        if (lastErr) out += `\n${theme.fg("dim", lastErr.slice(0, 120))}`;
      }
      return new Text(out, 0, 0);
    },
  });
}
