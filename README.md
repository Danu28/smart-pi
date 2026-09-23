# smart-pi

Runtime intelligence for the [pi coding agent](https://github.com/earendil-works/pi). A small extension — 4 tools, 1 command — that makes the agent *smarter inside a session*: it stops forgetting its thread after compaction, stops going blind to context usage, stops re-discovering the same project facts every turn, and stops claiming success without checking.

> Complements [pi-brain](https://github.com/Danu28/pi-brain): pi-brain is long-term **memory + reasoning + strict workflow** (remember/recall/think/plan/habit). smart-pi is **in-session runtime intelligence** (continuity, awareness, discovery, verification). No overlap — they compose.

## Priority order

| Priority | How smart-pi honors it |
|---|---|
| 1. Agent-friendly | Every tool returns compact, actionable text — no re-reading files required; tool descriptions teach when to call each tool |
| 2. High-productivity | Read-once intel, focus continuity across compaction, verify closure on every check |
| 3. User-friendly | One `/smart` status command; zero config; no mode switches to manage |
| 4. Cost-efficient | Tools registered **upfront** (KV-cache-friendly — no dynamic activation that invalidates the prefix); the only injected text is one focus line inside a *compaction summary* (zero steady-state cost) and a one-line warning only when context ≥ 90% full |

## Install

```bash
# recommended — one line, auto-updates with pi update --extensions
pi install git:github.com/Danu28/smart-pi

# pin a release tag
pi install git:github.com/Danu28/smart-pi@v1.0.0

# try without installing (one session)
pi -e git:github.com/Danu28/smart-pi

# local dev (no install, loads ./src/index.ts directly)
pi --extension ./src/index.ts
```

Then restart `pi` (or run `/reload`). Verify with `/smart` or `pi list`.

Needs pi `>= 0.85` (peer deps: `typebox`, `@earendil-works/pi-coding-agent`).

```bash
pi list                          # show installed packages
pi update --extensions           # update all git/npm packages
pi remove git:github.com/Danu28/smart-pi  # uninstall
```

## Tools

| Tool | Why it exists (the 5-step Question) | Behavior |
|---|---|---|
| `focus` | *After compaction, pi forgets "what am I doing right now"* | Working-memory scratchpad: `goal`, `files`, `acceptance`, `blocker`, `status working|blocked|done`, `clear:true`. Branch-safe (tool-result `details`, reference `todo.ts` pattern), rebuilt on `session_start`/`session_tree`, and **auto-injected into the compaction summary** so the resumed agent picks the thread right up. |
| `context-budget` | *Context overflow = aborted turn → retry → compaction = the #1 cost kill* | Reports `tokens / window / percent` with tiered advice (`clear ≤50`, `moderate ≤70`, `getting-full <90`, `critical ≥90`) and a 5-sample trend in details. `{compact:true}` fires `ctx.compact()`. A one-line warning is appended **only at ≥90%**, once per high-water period. |
| `project-intel` | *Every fresh session re-discovers test/lint/build commands and README intent* | Read-once profile: language, package.json scripts, detected `testCmd`/`lintCmd`/`buildCmd`, main entry, README excerpt, git branch/remote. Durable-cached (`smart:intel` entry) — later calls are **0 reads**. `{refresh:true}` re-scans; `{projectPath}` scans another dir. |
| `verify` | *Models call bash for checks but forget the exit code or drown in 50KB logs* | Runs a command (default 120s timeout), returns **PASS / FAIL / TIMEOUT + exit code + last 40 error lines**. Last 3 checks ride in details so the agent sees pass→fail transitions. Composes with `project-intel` (`testCmd`) and `focus` (`acceptance`). |

### Command

- `/smart` — status panel (notify): current focus, context usage, intel profile, last verify.

## Design: the 5-step algorithm applied

1. **Question** — what makes pi *dumb*? Four gaps: no thread continuity, no context awareness, repeated discovery, unverified success. One tool per gap; nothing else got a slot.
2. **Delete** — no memory (owned by pi-brain), no re-planning, no per-turn flow-note injection, no custom TUI, no config framework, no state files (state rides tool-result `details`).
3. **Simplify** — one tool per gap; plain optional params; every result is < 4KB of actionable text.
4. **Accelerate** — intel cache = 0-read repeats; verify tail-cuts logs; budget trend in details; all tools callable in parallel in one model turn.
5. **Automate** — only the two zero/low-cost automatons: focus line inside the compaction summary, and the ≥90% budget warning. Everything else stays on-demand (cost = 0 unless called).

## Cost model (why it's cheap)

- Tool **definitions** are fixed text in the system prompt — registered once at load, no dynamic activation (dynamic `setActiveTools` invalidates the cached prompt prefix → whole-transcript checkpoints on some providers).
- Tools inject **nothing** into the transcript except: (a) the focus line, which rides a compaction summary that is already being written, and (b) one warning line when ≥90% full.
- Repeated `project-intel` calls read **no files** (durable entry cache).
- `focus` and `verify` state live in tool-result `details` — branch-safe and free.

## Development

```bash
npm install          # dev deps (typebox, pi types, typescript)
npm run typecheck    # tsc --noEmit
```

Load with `pi --extension ./src/index.ts` and run `/smart`, then ask the agent to `project-intel`, set a `focus`, `context-budget`, and `verify`.

## License

MIT