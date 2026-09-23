/**
 * common.ts — shared utils for smart-pi.
 *
 * QDS (Question→Delete→Simplify→Accelerate→Automate) applied:
 *  - Question: every utility must serve >=1 of the 4 tools or the flow.
 *  - Delete: no class/DI, no config framework, no daemon — one Map of knobs.
 *  - Simplify: truncate + runCmd + branch-scan covers 95% of needs.
 *  - Accelerate: runCmd is a single child_process.exec (shell: true, works
 *    on win32 + posix); branch scans stop early when the tool name matches.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { exec } from "node:child_process";

// ---- knobs (tune without code change, like pi-brain) ----
export const MAX_TEXT = 4000; // max chars in any model-facing text block
export const VERIFY_TIMEOUT_S = 120; // default verify timeout (seconds)
export const VERIFY_TAIL_LINES = 40; // lines of error tail shown on failure
export const BUDGET_WARN_PCT = 90; // >= this -> inject one-line warning (before request)
export const BUDGET_CLEAR_PCT = 80; // usage must drop below this to re-arm warning
export const INTEL_README_CHARS = 2000; // README prefix distilled into profile
export const INTEL_SCRIPTS_MAX = 12; // max package.json scripts shown
export const INTEL_RUN_TIMEOUT = 3000; // git probes ms

export function truncate(text: string, max = MAX_TEXT): string {
  const s = text ?? "";
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars — narrow the scope or read the file]`;
}

export interface RunResult {
  code: number;
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run a shell command (cmd.exe on win32, /bin/sh elsewhere). Never throws. */
export function runCmd(
  command: string,
  opts: { cwd?: string; timeoutMs?: number; maxBuffer?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    try {
      const child = exec(
        command,
        {
          cwd: opts.cwd,
          timeout: opts.timeoutMs ?? VERIFY_TIMEOUT_S * 1000,
          maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          if (err) {
            const code = (err as { code?: number }).code ?? 1;
            resolve({
              code,
              ok: code === 0,
              stdout: stdout ?? "",
              stderr: stderr ?? "",
              timedOut: (err as { killed?: boolean }).killed === true,
            });
          } else {
            resolve({ code: 0, ok: true, stdout: stdout ?? "", stderr: stderr ?? "", timedOut: false });
          }
        },
      );
      // keep process alive-neutral: swallow ENOENT for missing cwd etc.
      child.on("error", () => {});
    } catch {
      resolve({ code: 1, ok: false, stdout: "", stderr: "failed to spawn command", timedOut: false });
    }
  });
}

/** Tail of combined output, preferring stderr (where errors usually land). */
export function tail(output: { stdout: string; stderr: string }, lines = VERIFY_TAIL_LINES): string {
  const combined = output.stderr.trim() ? output.stderr : output.stdout;
  const parts = combined.split(/\r?\n/);
  return parts.slice(-lines).join("\n");
}

/** Last N lines of a string (used for intel README distil). */
export function lastLines(text: string, n: number): string {
  return text.split(/\r?\n/).slice(-n).join("\n");
}

/** All tool-result details for a tool in branch order (oldest → newest). */
export function scanToolDetails(ctx: ExtensionContext, toolName: string): any[] {
  const out: any[] = [];
  try {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry?.type !== "message") continue;
      const msg = (entry as any).message;
      if (msg?.role === "toolResult" && msg?.toolName === toolName && typeof msg?.details === "object" && msg.details) {
        out.push(msg.details as any);
      }
    }
  } catch {
    /* branch not available — treat as empty */
  }
  return out;
}

export function lastToolDetails(ctx: ExtensionContext, toolName: string): any | undefined {
  return scanToolDetails(ctx, toolName).at(-1);
}

/** Durable appendEntry data for a custom type, in branch order (entry layer). */
export function scanEntries(ctx: ExtensionContext, entryType: string): any[] {
  const out: any[] = [];
  try {
    for (const e of ctx.sessionManager.getBranch()) {
      // newer shape: type "custom" / customType; legacy pi-brain shape: type "entry" / entryType
      if (e?.type === "custom") {
        const ct = (e as any).customType;
        if (ct === entryType && (e as any).data) out.push((e as any).data);
        continue;
      }
      if ((e as any)?.type === "entry") {
        const et = (e as any).entryType ?? (e as any).entry_type;
        if (et === entryType) {
          const d = (e as any).data ?? (e as any).entry ?? e;
          if (d) out.push(d);
        }
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

/** First day-of-week-agnostic ts helper. */
export function now(): number {
  return Date.now();
}

export function fmtAge(ts: number): string {
  const s = Math.max(0, Math.round((now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}