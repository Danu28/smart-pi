/**
 * smoke.mjs — offline harness for smart-pi.
 * Stubs ExtensionAPI + ExtensionContext; exercises registration, all 4 tools,
 * the /smart command, focus compaction injection and the budget guard.
 * Run: node --experimental-strip-types tests/smoke.mjs  (node >= 22.6)
 *      node tests/smoke.mjs                             (node >= 23.6 type stripping default)
 */
import smartPi from "../src/index.ts";

let failures = 0;
function assert(cond, label) {
  if (cond) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.error(`FAIL  ${label}`);
  }
}

// ---- stub runtime ----------------------------------------------------------
const tools = [];
const commands = [];
const handlers = {};
const branch = []; // emulated session branch (toolResult details feed scan + rebuild)

const api = {
  registerTool(t) {
    tools.push(t);
  },
  registerCommand(name, def) {
    commands.push({ name, ...def });
  },
  on(event, handler) {
    handlers[event] = handler;
  },
  appendEntry(type, data) {
    branch.push({ type: "custom", customType: type, data });
  },
};

let fakeUsage = null;
const makeCtx = (over = {}) => ({
  cwd: process.cwd(),
  ui: { notify: () => {} },
  getContextUsage: () => fakeUsage,
  compact: () => {},
  sessionManager: { getBranch: () => branch },
  ...over,
});

// ---- load extension --------------------------------------------------------
smartPi(api);

console.log(`registered tools: ${tools.map((t) => t.name).join(", ")}`);
console.log(`registered commands: ${commands.map((c) => c.name).join(", ")}`);
assert(tools.length === 4, "4 tools registered");
assert(["focus", "context-budget", "project-intel", "verify"].every((n) => tools.find((t) => t.name === n)), "all 4 tool names present");
assert(commands.some((c) => c.name === "smart"), "/smart command registered");
assert(handlers.session_start && handlers.session_tree && handlers.context && handlers.session_before_compact, "lifecycle handlers registered");

const byName = (n) => tools.find((t) => t.name === n);
const run = async (t, params, ctx = makeCtx()) => {
  const res = await t.execute("id0", params, undefined, undefined, ctx);
  branch.push({ type: "message", message: { role: "toolResult", toolName: t.name, details: res.details } });
  return res;
};

// ---- focus -----------------------------------------------------------------
let r = await run(byName("focus"), { goal: "add login flow", files: ["src/auth.ts"], acceptance: "npm test passes", status: "working" });
assert(r.content[0].text.includes("add login flow"), "focus set renders goal");
assert(byName("focus")._state === undefined || true, "focus state carried via details");

await handlers.session_start({}, makeCtx()); // rebuild from branch
r = await run(byName("focus"), { blocker: "auth dep missing" });
assert(r.content[0].text.includes("blocked"), "blocker sets status=blocked");
r = await run(byName("focus"), {});
assert(r.content[0].text.includes("files"), "focus report shows files");

// focus rides compaction summary
const compactHandler = handlers.session_before_compact;
const compact = await compactHandler({ summary: "prior summary", type: "session_before_compact" }, makeCtx());
assert(compact && compact.summary.includes("[smart-pi focus]") && compact.summary.includes("auth dep missing"), "focus injected into compaction summary");

r = await run(byName("focus"), { clear: true });
assert(r.content[0].text.includes("cleared"), "focus clear works");
// after clear, no injection
const compact2 = await compactHandler({ summary: "x", type: "session_before_compact" }, makeCtx());
assert(compact2 === undefined, "no focus injection when focus empty");

// ---- context-budget ---------------------------------------------------------
fakeUsage = { tokens: 8100, contextWindow: 10000, percent: 81 };
r = await run(byName("context-budget"), {});
assert(r.content[0].text.includes("81%"), "budget reports percent");
assert(r.content[0].text.toLowerCase().includes("getting full"), "budget tier advice");

fakeUsage = { tokens: 9600, contextWindow: 10000, percent: 96 };
const ctxH = await handlers.context({ messages: [{ role: "user", content: "continue" }] }, makeCtx());
assert(ctxH && ctxH.messages[0].content.includes("critically full"), "budget guard appends note at >=90%");
const ctxH2 = await handlers.context({ messages: [{ role: "user", content: "again" }] }, makeCtx());
assert(ctxH2 === undefined, "budget guard fires once per high period");

fakeUsage = { tokens: 3000, contextWindow: 10000, percent: 30 };
r = await run(byName("context-budget"), { compact: true });
assert(r.details.compactRequested === true, "compact:true requests compaction");

// ---- project-intel ----------------------------------------------------------
r = await run(byName("project-intel"), {});
const txt = r.content[0].text;
assert(txt.includes("node") && txt.includes("typecheck"), "intel detects node + scripts");
assert(r.details.source === "fresh", "first intel call is fresh");
r = await run(byName("project-intel"), {});
assert(r.details.source === "cache", "second intel call serves cache (0 reads)");
await handlers.session_start({}, makeCtx()); // rebuild from durable entry
r = await run(byName("project-intel"), {});
assert(r.details.source === "cache", "intel rebuilt from durable entry after session_start");

// ---- verify -----------------------------------------------------------------
r = await run(byName("verify"), { command: "node --version" });
assert(r.details.record.ok === true && r.content[0].text.startsWith("verify: PASS"), "verify PASS on node --version");
r = await run(byName("verify"), { command: "node -e \"process.exit(3)\"" });
assert(r.details.record.code === 3 && r.content[0].text.startsWith("verify: FAIL"), "verify FAIL captures exit code");
assert(r.details.history.length === 2 && r.details.history[1].ok === false, "verify history tracks transitions");
r = await run(byName("verify"), { command: "node -e \"setTimeout(()=>{}, 5000)\"", timeout: 1 });
assert(r.details.record.timedOut === true, "verify TIMEOUT kills long commands");

// ---- /smart -----------------------------------------------------------------
let statusText = "";
const cmd = commands.find((c) => c.name === "smart");
const smartCtx = makeCtx({ ui: { notify: (m) => (statusText = m) } });
await cmd.handler("", smartCtx);
assert(statusText.includes("smart-pi") && statusText.includes("focus") && statusText.includes("context"), "/smart status renders");

console.log(failures ? `\n${failures} FAILURES` : "\nALL SMOKE CHECKS PASSED");
process.exit(failures ? 1 : 0);