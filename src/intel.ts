/**
 * intel.ts — project-intel: read-once, cached project profile.
 *
 * QDS:
 *  - Question: every fresh session re-discovers the same facts (test/lint/build
 *    commands, entry points, README intention). That is wasted reads + tokens.
 *  - Delete: no repo-wide index, no full README — only a fixed, small profile
 *    of facts the agent actually needs to plan and verify.
 *  - Simplify: read a handful of small files once (parallel), distill, cache.
 *  - Accelerate: cache in a durable entry (`smart:intel`) + module memory →
 *    later calls are 0 reads. refresh:true re-scans.
 *  - Automate: nothing injected; tool is on-demand (cost = 0 unless called).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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

async function discover(cwd: string): Promise<ProjectProfile> {
  const probe = ["package.json", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "composer.json", "Gemfile", "CMakeLists.txt", "README.md", "README", "index.ts", "main.py", "src/main.rs", "main.go"];
  const present = new Set<string>();
  await Promise.all(probe.map(async (f) => (await exists(join(cwd, f))) && present.add(f)));

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
    label: "Project Intel",
    description:
      "Project profile: language, npm/git metadata, scripts (test/lint/build commands), main entry, README excerpt. Read once, cached durably — later calls are free. Call at the start of a task that needs build/test commands; refresh:true re-scans; projectPath to scan another dir.",
    parameters: IntelParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const target = params.projectPath ? String(params.projectPath).trim() : ctx.cwd;
      if (cached && cached.cwd === target && !params.refresh) {
        return {
          content: [{ type: "text", text: render(cached) }],
          details: { profile: cached, source: "cache" },
        };
      }
      const profile = await discover(target);
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
  });
}