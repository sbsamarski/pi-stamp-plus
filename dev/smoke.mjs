// Smoke test: loads the extension with a fake ExtensionAPI, replays Pi events and
// prints what the entry renderer would render (incl. a too-narrow terminal).
//
//   node --experimental-strip-types --no-warnings dev/smoke.mjs
//
// A stamp is queued when its entry finishes and appended at the start of the NEXT event,
// because Pi renders/persists an entry only after the extension handler returns. Scenarios
// therefore end with agent_end (as a real turn does) to flush the last stamp.
import { pathToFileURL } from "node:url";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The extension imports @earendil-works packages, which pi aliases to its own
// modules at runtime. Standalone (outside pi) we stage a copy whose bare
// specifiers are rewritten to absolute file URLs into the installed pi, so no
// local node_modules is needed. Type checking uses tsconfig "paths" the same way.
const PI_PKG = "C:/Users/serge/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent";
const here = join(process.argv[1], "..");

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "stamp-lite-"));
const settingsPath = join(process.env.PI_CODING_AGENT_DIR, "pi-stamp-lite.json");

const staged = join(here, "index.staged.ts");
writeFileSync(
	staged,
	readFileSync(join(here, "..", "index.ts"), "utf8")
		.replace(/from "@earendil-works\/pi-coding-agent"/g, `from "file:///${PI_PKG}/dist/index.js"`)
		.replace(/from "@earendil-works\/pi-tui"/g, `from "file:///${PI_PKG}/node_modules/@earendil-works/pi-tui/dist/index.js"`),
	"utf8",
);

const mod = await import(pathToFileURL(staged).href);
// The theme singleton lives in pi-coding-agent; it must be initialised before render().
const { initTheme } = await import(`file:///${PI_PKG}/dist/index.js`);
initTheme("dark", false);

const handlers = [];
const entries = [];
const notices = [];
let commandHandler = null;
let renderer = null;
let usageTokens = 62784;

/** Answers queued for the interactive select()/input() prompts. */
let scripted = [];

const pi = {
	on(name, fn) {
		handlers.push({ name, fn });
	},
	registerEntryRenderer(type, fn) {
		renderer = [type, fn];
	},
	registerCommand(name, def) {
		commandHandler = def.handler;
	},
	appendEntry(type, data) {
		entries.push({ type, data });
	},
};

const ctx = {
	mode: "print",
	ui: {
		notify(message, level) {
			notices.push(`${level ?? "info"}: ${message}`);
		},
		select(_title, options) {
			const pick = scripted.shift();
			if (pick === undefined) return Promise.resolve(options[options.length - 1]);
			if (pick === "\u001b") return Promise.resolve(undefined); // Escape
			return Promise.resolve(options.find((o) => o.startsWith(`${pick}:`)) ?? pick);
		},
		input(_title, _placeholder, _opts) {
			return Promise.resolve(scripted.shift());
		},
	},
	getContextUsage: () => ({ tokens: usageTokens, contextWindow: 131072, percent: 47 }),
	sessionManager: {
		// Post-compaction context: the summary plus the kept messages.
		buildContextEntries: () => [
			{ type: "compaction", id: "c", parentId: null, timestamp: new Date().toISOString(), summary: "s".repeat(4000), firstKeptEntryId: "k" },
			{ type: "message", id: "k", parentId: "c", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "kept message" }] } },
		],
	},
};

// Activate the extension against the fake API.
mod.default(pi);

const fire = async (name, event = {}) => {
	for (const h of handlers) if (h.name === name) await h.fn(event, ctx);
};

/** Fresh session state (settings file is re-read) and an empty entry log. */
const reset = async (config = "{}") => {
	writeFileSync(settingsPath, typeof config === "string" ? config : JSON.stringify(config), "utf8");
	entries.length = 0;
	notices.length = 0;
	await fire("session_start");
};

const clock = Date.now() - 30_000; // 30 s ago: durations and date tags look realistic
const usage = { input: 101, output: 584, reasoning: 120, cacheRead: 57424, cacheWrite: 0, totalTokens: 58109 };
const usageAnswer = { input: 84, output: 241, reasoning: 0, cacheRead: 58109, cacheWrite: 0, totalTokens: 58434 };
const callOne = { type: "toolCall", id: "c1", name: "bash", arguments: {} };
const callTwo = { type: "toolCall", id: "c2", name: "read", arguments: {} };

/** User prompt, then an assistant call that asks for tools. */
const promptAndToolCall = (calls = [callOne], at = 700) => [
	["message_start", { message: { role: "user", timestamp: clock, content: [{ type: "text", text: "hi there" }] } }],
	["message_end", { message: { role: "user", timestamp: clock, content: [{ type: "text", text: "hi there" }] } }],
	["message_start", { message: { role: "assistant", timestamp: clock + at, usage, content: [] } }],
	[
		"message_update",
		{
			message: { role: "assistant", timestamp: clock + at, usage, content: [] },
			assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: {} },
		},
	],
	["message_end", { message: { role: "assistant", timestamp: clock + at, usage, stopReason: "toolUse", content: calls } }],
];
/** One tool run, ending with its output message (Pi renders the output before persisting it). */
const toolRun = (toolName = "bash", isError = false, result = undefined, id = "c1", at = 29_700) => [
	["tool_execution_start", { toolCallId: id, toolName }],
	["tool_execution_end", { toolCallId: id, toolName, isError, result }],
	["message_start", { message: { role: "toolResult", toolCallId: id, toolName, timestamp: clock + at, content: [] } }],
	["message_end", { message: { role: "toolResult", toolCallId: id, toolName, timestamp: clock + at, content: [] } }],
];
const answerEvents = (over = {}) => [
	["message_start", { message: { role: "assistant", timestamp: clock + 29_800, content: [] } }],
	[
		"message_end",
		{
			message: {
				role: "assistant",
				timestamp: clock + 29_800,
				usage: usageAnswer,
				stopReason: "stop",
				content: [{ type: "text", text: "here you go" }],
				...over,
			},
		},
	],
	["agent_end", {}],
];
const END = ["agent_end", {}];

const renderAll = (width) =>
	entries.map(({ type, data }) => {
		if (type !== renderer[0]) return "<other entry>";
		const c = renderer[1]({ type: "custom", customType: type, data }, { expanded: false }, {
			fg: (color, text) => `[${color}]${text}[/]`,
		});
		return c === undefined ? "<hidden>" : c.render(width).join("⏎");
	});

const show = async (label, events) => {
	for (const [name, event] of events ?? []) {
		if (name === "sleep") await new Promise((resolve) => setTimeout(resolve, event.ms ?? 60));
		else await fire(name, event);
	}
	console.log(`\n--- ${label} ---`);
	for (const line of renderAll(200)) console.log(line);
};

const assert = (label, ok) => {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
	if (!ok) process.exitCode = 1;
};
const kind = (i) => entries[i]?.data.kind;
const tools = (i) => entries[i]?.data.tools?.join(", ");

// 1. Normal tool turn: prompt, call, tool output, answer.
await reset();
await show("tool call, then the answer (attach mode)", [
	...promptAndToolCall(),
	...toolRun("bash"),
	...answerEvents(),
]);
assert("one stamp per entry, in transcript order", entries.length === 3);
assert("your line is first and carries In and Ctx", kind(0) === "user" && entries[0].data.userIn === 2 && entries[0].data.ctxTokens === 62784);
assert("the call's own line comes right after it, without tool info", kind(1) === "assistant" && tools(1) === undefined);
assert("the answer line carries the tool that ran before it", kind(2) === "assistant" && tools(2) === "bash" && entries[2].data.toolOk === true);

// 2. A prompt that arrives immediately after a message must not steal its stamp.
await reset();
await show("new prompt right after a tool call", [
	promptAndToolCall()[0],
	promptAndToolCall()[1],
	...promptAndToolCall().slice(2),
	["message_start", { message: { role: "user", timestamp: clock + 900, content: [] } }],
	["message_end", { message: { role: "user", timestamp: clock + 900, content: [] } }],
	END,
]);
assert("the call's stamp lands before the next prompt's", entries.map((_, i) => kind(i)).join(",") === "user,assistant,user");

// 3. A batch of tools lands together on the next stamp.
await reset();
await show("two tools, one failing", [
	...promptAndToolCall([callOne, callTwo]),
	...toolRun("bash", false, undefined, "c1"),
	...toolRun("read", true, { content: [{ type: "text", text: "no such file" }] }, "c2", 29_750),
	...answerEvents(),
]);
assert("the batch is on one line", tools(2) === "bash, read" && entries[2].data.toolOk === false);
assert("the failing tool's text is shown", renderAll(200)[2].includes("ERROR: no such file"));

// 4. Reasoning tokens are labelled Think.
const usageThink = { input: 10, output: 500, reasoning: 300, cacheRead: 0, cacheWrite: 0, totalTokens: 510 };
await reset();
await show("showReasoning off", answerEvents({ usage: usageThink }));
assert("no reasoning tokens by default", !renderAll(200)[0].includes("Think"));
await reset({ showReasoning: true });
await show("showReasoning on", answerEvents({ usage: usageThink }));
assert("Think label shown when enabled", renderAll(200)[0].includes("Think 300"));

// 5. toolLine=own: the answer's stamp stays under the answer, the tool gets its own line
// under the tool output. toolLine=off writes neither.
await reset({ toolLine: "own" });
await show("toolLine=own", [...promptAndToolCall(), ...toolRun("bash"), ...answerEvents()]);
assert("own mode: answer stamp, then the tool's own line", entries.map((_, i) => kind(i)).join(",") === "user,assistant,tool,assistant");
assert("the answer's line keeps the speed info and no tool name", kind(1) === "assistant" && tools(1) === undefined && renderAll(200)[1].includes("t/s"));
assert("the tool's line carries its own duration", renderAll(200)[2].includes("bash") && renderAll(200)[2].includes("OK"));
await reset({ toolLine: "off" });
await show("toolLine=off", [
	["tool_execution_start", { toolCallId: "t2", toolName: "read" }],
	["tool_execution_end", { toolCallId: "t2", toolName: "read", isError: false }],
	END,
]);
assert("off mode writes no tool stamp", entries.length === 0);

// 6. Failures and abnormal stops. Pi rewrites an interrupted message after its own message_end,
// so those stamps wait one extra event and still land below the message they describe.
await reset();
await show("abort", [...answerEvents({ stopReason: "aborted" }), ["turn_start", {}]]);
assert("an aborted call is marked", renderAll(200)[0].includes("ABORTED"));
assert("an interrupted call is still stamped below its own message", entries.length === 1 && kind(0) === "assistant");
await reset();
await show("provider error", [...answerEvents({ stopReason: "error", errorMessage: "llama server returned 500" }), ["turn_start", {}]]);
assert("a provider error shows its text", renderAll(200)[0].includes("ERROR: llama server returned 500"));

// 6b. Compaction lines, fed with the usage Pi stores on the compaction entry.
const compactionEntry = {
	type: "compaction",
	timestamp: new Date(clock + 5000).toISOString(),
	tokensBefore: 100318,
	firstKeptEntryId: "k",
	summary: "…",
	usage: { input: 63667, output: 15500, reasoning: 0, cacheRead: 0, totalTokens: 79167 },
};
await reset();
await show("auto compaction", [
	["session_before_compact", { preparation: { tokensBefore: 100318 }, branchEntries: [], reason: "threshold", willRetry: false }],
	["sleep", { ms: 60 }], // give the compaction a measurable duration
	["session_compact", { compactionEntry, fromExtension: false, reason: "threshold", willRetry: false }],
]);
const comp = renderAll(200)[0] ?? "";
assert("one compaction line", entries.length === 1 && kind(0) === "compaction");
assert("it names the trigger", comp.includes("Compaction (auto)"));
assert("it shows the summary call's own usage", comp.includes("In 63,667") && comp.includes("Out 15,500"));
assert("it shows context before → after", /Ctx 100,318 → ~[\d,]+/.test(comp));
assert("it shows averaged speeds", comp.includes("t/s") && comp.includes("OK"));

await reset();
await show("compaction failed", [
	["session_before_compact", { preparation: { tokensBefore: 90000 }, branchEntries: [], reason: "overflow", willRetry: true }],
	["session_compact_failed", { reason: "overflow", errorMessage: "context length exceeded", aborted: false, willRetry: true, fromExtension: false }],
]);
assert("a failed compaction says so", renderAll(200)[0].includes("Compaction (overflow)") && renderAll(200)[0].includes("ERROR: context length exceeded"));

await reset();
await show("compaction cancelled", [
	["session_before_compact", { preparation: { tokensBefore: 90000 }, branchEntries: [], reason: "manual", willRetry: false }],
	["session_compact_failed", { reason: "manual", errorMessage: "Compaction cancelled", aborted: true, willRetry: false, fromExtension: false }],
]);
assert("a cancelled compaction is marked ABORTED", renderAll(200)[0].includes("ABORTED"));

await reset({ showCompaction: false });
await show("showCompaction off", [
	["session_before_compact", { preparation: { tokensBefore: 100318 }, branchEntries: [], reason: "threshold", willRetry: false }],
	["session_compact", { compactionEntry, fromExtension: false, reason: "threshold", willRetry: false }],
]);
assert("showCompaction off writes nothing", entries.length === 0);

// 7. Legacy entries written by earlier versions still render.
await reset();
entries.push({
	type: "pi-stamp-lite",
	data: { v: 1, kind: "assistant", ts: clock, t0: clock, firstAt: clock + 200, endAt: clock + 31200, usage, stop: "stop" },
});
entries.push({ type: "pi-stamp-lite", data: { v: 1, kind: "tool", ts: clock + 500, tool: "grep", durMs: 250, ok: true } });
console.log("\n--- legacy entries: v1 assistant (no ctxTokens) and a v1 tool line ---");
const legacy = renderAll(200);
console.log(legacy.join("\n"));
assert("Ctx is derived for old entries", legacy[0].includes("Ctx 58,109"));
assert("old standalone tool lines stay hidden", legacy[1] === "<hidden>");
entries.length = 0;

// 8. Narrow terminal: the line must survive on one row.
await reset();
await show("full turn (for the narrow test)", [...promptAndToolCall(), ...toolRun("read"), ...answerEvents()]);
console.log("--- the same stamps at 60 columns ---");
for (const line of renderAll(60)) console.log(`${line}  (width ${line.length})`);
const plain = (l) => l.replace(/\[warning\]|\[\/\]/g, "");
assert("narrow lines stay on one row", renderAll(60).every((l) => !l.includes("⏎") && plain(l).length <= 60));

// 9. Command: status, direct change, menu, unknown field.
await reset();
await commandHandler("status", ctx);
console.log(`\n/status -> ${notices.at(-1)}`);
await commandHandler("showCache off", ctx);
console.log(`/showCache off -> ${notices.at(-1)}`);
assert("the command writes the config", JSON.parse(readFileSync(settingsPath, "utf8")).showCache === false);
await commandHandler("showCache on", ctx);

// The interactive menu needs TUI mode.
ctx.mode = "tui";
scripted = ["tool info", "own", "\u001b"];
await commandHandler("", ctx);
assert("the menu writes the config", JSON.parse(readFileSync(settingsPath, "utf8")).toolLine === "own");
ctx.mode = "print";
await commandHandler("menu", ctx);
assert("menu outside TUI says so instead of failing", notices.at(-1).includes("interactive terminal"));
await reset();

await commandHandler("bogus", ctx);
console.log(`/bogus -> ${notices.at(-1)}`);
assert("unknown fields are refused", notices.at(-1).startsWith("warning: unknown field"));

// 10. A broken config must fall back to defaults and warn.
writeFileSync(settingsPath, "{ not json", "utf8");
notices.length = 0;
await fire("session_start");
console.log(`\nbroken config -> ${notices.at(-1)}`);
assert("a broken config warns and keeps working", notices.length > 0);
rmSync(process.env.PI_CODING_AGENT_DIR, { recursive: true, force: true });
rmSync(staged, { force: true });
