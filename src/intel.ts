/**
 * intel.ts — project-intel: read-once, cached project profile.
 *
 * Seamless pi integration:
 * - promptSnippet + promptGuidelines
 * - renderCall/renderResult themed like read/ls (collapsed script summary, expanded git+readme)
 * - signal + onUpdate streaming support
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { INTEL_README_CHARS, INTEL_RUN_TIMEOUT, INTEL_SCRIPTS_MAX, runCmd, scanEntries, truncate } from "./common";

export interface ProjectProfile {
  cwd: string;
  lang: string;
  name?: string;
  packageManager?: string;
  scripts: Record<string, string>;
  testCmd?: string;
  lintCmd?: string;
  buildCmd?: string;
  main?: string;
  readmeExcerpt?: string;
  gitBranch?: string;
  gitRemote?: string;
  scannedAt: number;
}

let cached: ProjectProfile | undefined;

export function getCachedProfile(): ProjectProfile | undefined {
  return cached;
}

export function rebuildIntel(ctx: ExtensionContext): void {
  const last = scanEntries(ctx, "smart:intel").at(-1) as ProjectProfile | undefined;
  if (last && typeof last?.cwd === "string" && last.scannedAt) cached = last;
}

async function exists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

async function readSmall(p: string, max = 64 * 1024): Promise<string | undefined> {
  try {
    const buf = await readFile(p);
    return buf.subarray(0, max).toString("utf8");
  } catch {
    return undefined;
  }
}

function detectLang(dir: string, files: string[]): string {
  if (files.includes("pyproject.toml") || files.includes("requirements.txt") || files.includes("setup.py")) return "python";
  if (files.includes("Cargo.toml")) return "rust";
  if (files.includes("go.mod")) return "go";
  if (files.includes("pom.xml") || files.includes("build.gradle") || files.includes("build.gradle.kts")) return "java";
  if (files.includes("package.json")) return "node";
  if (files.includes("composer.json")) return "php";
  if (files.includes("Gemfile")) return "ruby";
  if (files.includes("CMakeLists.txt")) return "cpp";
  return "unknown";
}

async function discover(cwd: string, signal?: AbortSignal, onUpdate?: (msg: string) => void): Promise<ProjectProfile> {
  if (signal?.aborted) throw new Error("Operation aborted");
  const probe = ["package.json", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "composer.json", "Gemfile", "CMakeLists.txt", "README.md", "README", "index.ts", "main.py", "src/main.rs", "main.go"];
  const present = new Set<string>();
  onUpdate?.("scanning project files…");
  await Promise.all(probe.map(async (f) => (await exists(join(cwd, f))) && present.add(f)));
  if (signal?.aborted) throw new Error("Operation aborted");

  const lang = detectLang(cwd, [...present]);
  const profile: ProjectProfile = { cwd, lang, scripts: {}, scannedAt: Date.now() };

  if (present.has("package.json")) {
    const raw = await readSmall(join(cwd, "package.json"));
    try {
      const pkg = JSON.parse(raw ?? "{}");
      profile.name = typeof pkg.name === "string" ? pkg.name : undefined;
      profile.packageManager = typeof pkg.packageManager === "string" ? pkg.packageManager : undefined;
      profile.main = typeof pkg.main === "string" ? pkg.main : typeof pkg.bin === "string" ? pkg.bin : undefined;
      const scripts = pkg.scripts && typeof pkg.scripts === "object" ? (pkg.scripts as Record<string, string>) : {};
      profile.scripts = Object.fromEntries(Object.entries(scripts).slice(0, INTEL_SCRIPTS_MAX));
      profile.testCmd = profile.scripts.test ?? profile.scripts["test:run"];
      profile.lintCmd = profile.scripts.lint ?? profile.scripts.check ?? profile.scripts["typecheck"];
      profile.buildCmd = profile.scripts.build ?? profile.scripts.compile;
      const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) } as Record<string, unknown>;
      if (!profile.testCmd) {
        if (allDeps["vitest"]) profile.testCmd = "npx vitest run";
        else if (allDeps["jest"]) profile.testCmd = "npx jest";
        else if (allDeps["mocha"]) profile.testCmd = "npx mocha";
        else if (allDeps["tsx"]) profile.testCmd = "node --test";
      }
      if (!profile.lintCmd && allDeps["eslint"] && typeof allDeps["eslint"] === "string") {
        profile.lintCmd = "npx eslint .";
      }
    } catch {
      /* unparseable package.json — leave defaults */
    }
  } else if (lang === "python") {
    profile.testCmd = "pytest";
    profile.lintCmd = "ruff check .";
    profile.buildCmd = "pip install -e .";
  } else if (lang === "rust") {
    profile.testCmd = "cargo test";
    profile.buildCmd = "cargo build";
  } else if (lang === "go") {
    profile.testCmd = "go test ./...";
    profile.buildCmd = "go build ./...";
  }

  onUpdate?.("reading README + git…");
  const readme = present.has("README.md") ? await readSmall(join(cwd, "README.md"), INTEL_README_CHARS) : present.has("README") ? await readSmall(join(cwd, "README"), INTEL_README_CHARS) : undefined;
  if (readme?.trim()) {
    profile.readmeExcerpt = truncate(readme.replace(/\r/g, "").trim(), 900);
  }

  const gitBranch = await runCmd("git rev-parse --abbrev-ref HEAD", { cwd, timeoutMs: INTEL_RUN_TIMEOUT });
  profile.gitBranch = gitBranch.ok ? gitBranch.stdout.trim() : undefined;
  const gitRemote = await runCmd("git remote get-url origin", { cwd, timeoutMs: INTEL_RUN_TIMEOUT });
  profile.gitRemote = gitRemote.ok ? gitRemote.stdout.trim() : undefined;
  return profile;
}

function render(p: ProjectProfile): string {
  const lines: string[] = [
    `project: ${p.name ?? p.cwd.split(/[\\/]/).pop() ?? p.cwd} (${p.lang})${p.packageManager ? ` · ${p.packageManager}` : ""}`,
  ];
  if (p.gitBranch) lines.push(`git: ${p.gitBranch}${p.gitRemote ? ` (${p.gitRemote.replace(/^.*@|^https?:\/\//, "").replace(/\.git$/, "")})` : ""}`);
  if (Object.keys(p.scripts).length) lines.push(`scripts: ${Object.entries(p.scripts).map(([k, v]) => `${k} → ${v}`).join(" | ")}`);
  lines.push(`test: ${p.testCmd ?? "not detected"} | lint: ${p.lintCmd ?? "not detected"} | build: ${p.buildCmd ?? "not detected"}`);
  if (p.main) lines.push(`main: ${p.main}`);
  if (p.readmeExcerpt) lines.push(`readme: ${p.readmeExcerpt.replace(/\s+/g, " ").trim()}`);
  lines.push(`scanned: ${new Date(p.scannedAt).toLocaleTimeString()} — use project-intel {refresh:true} to re-scan`);
  return lines.join("\n");
}

const IntelParams = Type.Object({
  refresh: Type.Optional(Type.Boolean({ description: "Force a fresh scan (default: serve cache)" })),
  projectPath: Type.Optional(Type.String({ description: "Scan a different directory (default: cwd)" })),
});

export function registerIntelTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "project-intel",
    label: "project-intel",
    description:
      "Project profile: language, npm/git metadata, scripts (test/lint/build commands), main entry, README excerpt. Read once, cached durably — later calls are free. Call at the start of a task that needs build/test commands; refresh:true re-scans; projectPath to scan another dir.",
    promptSnippet: "Project intel — language, scripts, test/lint/build",
    promptGuidelines: [
      "Call project-intel once at task start to get testCmd/lintCmd/buildCmd — later calls are cached (0 reads).",
      "Use its testCmd with verify instead of guessing npm scripts.",
    ],
    parameters: IntelParams,
    async execute(_id, params, signal, onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Operation aborted");
      const target = params.projectPath ? String(params.projectPath).trim() : ctx.cwd;
      if (cached && cached.cwd === target && !params.refresh) {
        return {
          content: [{ type: "text", text: render(cached) }],
          details: { profile: cached, source: "cache" },
        };
      }
      const doUpdate = (text: string) => {
        try {
          onUpdate?.({ content: [{ type: "text", text }], details: { profile: undefined, source: "scanning" } } as any);
        } catch {}
      };
      const profile = await discover(target, signal, doUpdate);
      if (signal?.aborted) throw new Error("Operation aborted");
      cached = profile;
      try {
        (pi as any).appendEntry?.("smart:intel", profile);
      } catch {
        /* durable cache best-effort */
      }
      return {
        content: [{ type: "text", text: render(profile) }],
        details: { profile, source: "fresh" },
      };
    },
    renderCall(args, theme, _ctx) {
      let text = theme.fg("toolTitle", theme.bold("project-intel"));
      if (args.projectPath) text += ` ${theme.fg("accent", args.projectPath)}`;
      if (args.refresh) text += theme.fg("warning", " refresh");
      else text += theme.fg("dim", " — cached if available");
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded }, theme, _ctx) {
      const details = result.details as { profile?: ProjectProfile; source?: string } | undefined;
      const p = details?.profile;
      const src = details?.source;
      if (src === "scanning") {
        const txt = result.content[0]?.type === "text" ? result.content[0].text : "Scanning…";
        return new Text(theme.fg("warning", txt), 0, 0);
      }
      if (!p) {
        const txt = result.content[0]?.type === "text" ? result.content[0].text : "";
        return new Text(theme.fg("toolOutput", txt.slice(0, 500)), 0, 0);
      }
      const name = p.name ?? p.cwd.split(/[\\/]/).pop() ?? p.cwd;
      let out = `${theme.fg("accent", name)} ${theme.fg("dim", `(${p.lang})`)}`;
      if (p.gitBranch) out += ` ${theme.fg("muted", p.gitBranch)}`;
      out += src === "cache" ? theme.fg("dim", " · cached") : theme.fg("success", " · fresh");
      const cmds: string[] = [];
      if (p.testCmd) cmds.push(`test:${p.testCmd}`);
      if (p.lintCmd) cmds.push(`lint:${p.lintCmd}`);
      if (p.buildCmd) cmds.push(`build:${p.buildCmd}`);
      if (cmds.length) out += `\n${theme.fg("muted", cmds.join("  ·  "))}`;
      if (expanded) {
        if (Object.keys(p.scripts).length) {
          out += `\n${theme.fg("dim", Object.entries(p.scripts).slice(0, 6).map(([k, v]) => `${k}→${v}`).join(" | "))}`;
        }
        if (p.main) out += `\n${theme.fg("muted", "main:")} ${theme.fg("toolOutput", p.main)}`;
        if (p.readmeExcerpt) out += `\n${theme.fg("dim", p.readmeExcerpt.slice(0, 200).replace(/\s+/g, " "))}…`;
      }
      return new Text(out, 0, 0);
    },
  });
}
