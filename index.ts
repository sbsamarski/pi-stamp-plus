/**
 * pi-stamp-plus — left-aligned single-line stamps for the Pi transcript.
 *
 * One line per transcript entry, left aligned, in one theme colour, written AFTER the
 * entry it describes, in this order:
 *   time · duration · In · Out · Cache · TG · PP · Ctx · tool · result
 *
 *   00:31:36 · In 300 · Ctx 62,784                                        (your message)
 *   00:32:04 · 35.7s · In 101 · Out 584 · Cache 57,424 · TG 16.9 t/s · PP 82 t/s · Ctx 58,109
 *   00:32:41 · 0.4s · In 84 · Out 241 · Ctx 58,350 · bash · OK           (answer after a tool)
 *
 * Thinking, text and tool calls are blocks of ONE assistant message, so one stamp covers
 * them all and it lands directly below that message — before the output of the tool it
 * asked for. Tool names and their OK/ERROR result attach to the stamp of the NEXT assistant
 * message (see `toolLine`): the line of the call itself cannot report a result that has
 * not happened yet. The duration is the wall time of that LLM call; tool time is inside it.
 * `Ctx` is the context size (prompt including cached tokens plus generated tokens), i.e.
 * roughly what sits in the KV cache. `In` on your own line is an estimate of what you
 * typed; `In` on an assistant line is exact usage (non-cached prompt tokens of that call).
 *
 * PP (prompt processing) and TG (token generation) are client-side estimates: Pi does not
 * receive llama.cpp server timings, so PP = new prompt tokens / (first content - request
 * start) and TG = output tokens / (end - first content). A big `In` with a small `Cache`
 * means the prefix cache was cold and the whole prompt had to be re-read.
 *
 * Stamps are custom session entries (pi.appendEntry) rendered by pi.registerEntryRenderer,
 * so they never enter the LLM context. Pi runs extension handlers BEFORE it renders and
 * persists the message that triggered them, so a stamp written straight from message_end
 * would land ABOVE that message. Stamps are therefore queued and appended at the start of
 * the NEXT handler: the described entry is on screen by then and no newer entry has been
 * added yet. A timer cannot do this — a fast-following user prompt gets rendered first, and
 * the stamp ends up under the wrong entry.
 * Pi's CustomEntryComponent always draws one blank line above a custom entry; that spacer
 * belongs to the host and cannot be removed from an extension.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	estimateTokens,
	getAgentDir,
	type CustomEntry,
	type EntryRenderer,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "pi-stamp-plus";
const LEGACY_ENTRY_TYPE = "pi-stamp-plus";   // stamps already stored in old sessions
const SETTINGS_FILE = "pi-stamp-plus.json";
const STAMP_VERSION = 3;
const MAX_ACTIVE_MESSAGES = 64;
const FIRST_CONTENT_EVENTS = new Set([
	"text_start",
	"text_delta",
	"thinking_start",
	"thinking_delta",
	"toolcall_start",
	"toolcall_delta",
]);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** How tool information reaches the transcript. */
type ToolLineMode = "attach" | "own" | "off";

/** Theme colour tokens a stamp line can use; `warning` is yellow in the built-in themes. */
const STAMP_COLORS = [
	"warning",
	"accent",
	"success",
	"error",
	"text",
	"muted",
	"dim",
	"toolTitle",
	"customMessageLabel",
] as const;
type StampColor = (typeof STAMP_COLORS)[number];

interface StampLiteSettings {
	hourCycle: "24h" | "12h";
	/** Which moment the clock shows for assistant and tool lines. */
	stampTime: "start" | "end";
	showSeconds: boolean;
	showDate: boolean;
	userLine: boolean;
	/** `attach` = tool name and outcome on the next stamp line, `own` = its own line, `off` = nothing. */
	toolLine: ToolLineMode;
	/** Write a line for each compaction (manual, auto, overflow) with its own usage. */
	showCompaction: boolean;
	showDuration: boolean;
	showPrefillSpeed: boolean;
	showGenSpeed: boolean;
	showTokensIn: boolean;
	showTokensOut: boolean;
	showReasoning: boolean;
	showCache: boolean;
	/** Show the context size of that call (prompt including cache + generated). */
	showContext: boolean;
	/** Colour of the whole stamp line. */
	stampColor: StampColor;
	/** How many leading characters of error text to show after `ERROR:` (0 = label only). */
	errorTextChars: number;
}

const DEFAULTS: StampLiteSettings = {
	hourCycle: "24h",
	stampTime: "start",
	showSeconds: true,
	showDate: true,
	userLine: true,
	toolLine: "attach",
	showCompaction: true,
	showDuration: true,
	showPrefillSpeed: true,
	showGenSpeed: true,
	showTokensIn: true,
	showTokensOut: true,
	showReasoning: false,
	showCache: true,
	showContext: true,
	stampColor: "warning",
	errorTextChars: 50,
};

const ERROR_TEXT_CHARS_MAX = 500;
/** Upper bound on error text kept in the session file (display clips further). */
const STORED_ERROR_CHARS = 300;
/** How many tool names of one batch are listed before `+N`. */
const TOOL_NAMES_SHOWN = 3;
/** Upper bound on tool results waiting for the stamp line they attach to. */
const MAX_PENDING_TOOLS = 8;
/** Token heuristic identical to Pi's own estimator (chars / 4, images counted as 4800). */
const CHARS_PER_TOKEN = 4;
const IMAGE_CHARS = 4800;
/** Stop reasons that count as a normal finish and get no marker. */
const NORMAL_STOPS = new Set(["stop", "toolUse", "length"]);

/** Allowed values of the non-boolean settings, used by the /stamp-lite menu. */
const ENUM_KEYS = {
	hourCycle: ["24h", "12h"],
	stampTime: ["start", "end"],
	toolLine: ["attach", "own", "off"],
	stampColor: STAMP_COLORS,
} as const;
type EnumKey = keyof typeof ENUM_KEYS;

/** Settings shown in the /stamp-lite menu, in menu order, with human labels. */
const FIELD_LABELS: readonly (readonly [keyof StampLiteSettings, string])[] = [
	["hourCycle", "clock"],
	["stampTime", "stamp time"],
	["showSeconds", "seconds"],
	["showDate", "date tag"],
	["userLine", "user line"],
	["toolLine", "tool info"],
	["showCompaction", "compaction line"],
	["showDuration", "duration"],
	["showPrefillSpeed", "PP speed"],
	["showGenSpeed", "TG speed"],
	["showTokensIn", "In tokens"],
	["showTokensOut", "Out tokens"],
	["showReasoning", "Think tokens"],
	["showCache", "Cache tokens"],
	["showContext", "Ctx tokens"],
	["stampColor", "colour"],
	["errorTextChars", "error text chars"],
];

/** Lower-case command argument -> setting name, including a few friendly aliases. */
const ALIASES: Record<string, keyof StampLiteSettings> = {};
for (const key of Object.keys(DEFAULTS) as (keyof StampLiteSettings)[]) ALIASES[key.toLowerCase()] = key;
ALIASES.colour = "stampColor";
ALIASES.tools = "toolLine";
ALIASES.errorchars = "errorTextChars";

type BooleanKey = { [K in keyof StampLiteSettings]: StampLiteSettings[K] extends boolean ? K : never }[keyof StampLiteSettings];

const BOOLEAN_KEYS: readonly BooleanKey[] = [
	"showSeconds",
	"showDate",
	"userLine",
	"showCompaction",
	"showDuration",
	"showPrefillSpeed",
	"showGenSpeed",
	"showTokensIn",
	"showTokensOut",
	"showReasoning",
	"showCache",
	"showContext",
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadSettings(): { settings: StampLiteSettings; issues: string[] } {
	const settings: StampLiteSettings = { ...DEFAULTS };
	const issues: string[] = [];
	let text: string;
	try {
		text = readFileSync(join(getAgentDir(), SETTINGS_FILE), "utf8");
	} catch {
		return { settings, issues }; // missing file is the normal case
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		issues.push(`${SETTINGS_FILE}: invalid JSON (${(error as Error).message}), using defaults`);
		return { settings, issues };
	}
	if (!isRecord(parsed)) {
		issues.push(`${SETTINGS_FILE}: document must be a JSON object, using defaults`);
		return { settings, issues };
	}
	if ("hourCycle" in parsed) {
		if (parsed.hourCycle === "24h" || parsed.hourCycle === "12h") settings.hourCycle = parsed.hourCycle;
		else issues.push(`hourCycle must be "24h" or "12h", using ${DEFAULTS.hourCycle}`);
	}
	if ("stampTime" in parsed) {
		if (parsed.stampTime === "start" || parsed.stampTime === "end") settings.stampTime = parsed.stampTime;
		else issues.push(`stampTime must be "start" or "end", using ${DEFAULTS.stampTime}`);
	}
	if ("toolLine" in parsed) {
		const value = parsed.toolLine;
		if (value === "attach" || value === "own" || value === "off") settings.toolLine = value;
		else if (typeof value === "boolean") {
			settings.toolLine = value ? "own" : "off";
			issues.push(`toolLine is now "attach", "own" or "off", using ${settings.toolLine}`);
		} else issues.push(`toolLine must be "attach", "own" or "off", using ${DEFAULTS.toolLine}`);
	}
	if ("stampColor" in parsed) {
		const value = parsed.stampColor;
		if (typeof value === "string" && (STAMP_COLORS as readonly string[]).includes(value)) {
			settings.stampColor = value as StampColor;
		} else {
			issues.push(`stampColor must be one of ${STAMP_COLORS.join(", ")}, using ${DEFAULTS.stampColor}`);
		}
	}
	for (const key of BOOLEAN_KEYS) {
		if (key in parsed) {
			if (typeof parsed[key] === "boolean") settings[key] = parsed[key] as boolean;
			else issues.push(`${key} must be true or false, using ${DEFAULTS[key]}`);
		}
	}
	if ("errorTextChars" in parsed) {
		const value = parsed.errorTextChars;
		if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= ERROR_TEXT_CHARS_MAX) {
			settings.errorTextChars = Math.floor(value);
		} else {
			issues.push(`errorTextChars must be a number from 0 to ${ERROR_TEXT_CHARS_MAX}, using ${DEFAULTS.errorTextChars}`);
		}
	}
	return { settings, issues };
}

/** Write the settings file atomically (temp file + rename), as the /stamp-lite menu does. */
function saveSettings(settings: StampLiteSettings): void {
	const target = join(getAgentDir(), SETTINGS_FILE);
	const tmp = `${target}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
	renameSync(tmp, target);
}

function setEnum(settings: StampLiteSettings, key: EnumKey, value: string): boolean {
	switch (key) {
		case "hourCycle":
			if (value === "24h" || value === "12h") {
				settings.hourCycle = value;
				return true;
			}
			return false;
		case "stampTime":
			if (value === "start" || value === "end") {
				settings.stampTime = value;
				return true;
			}
			return false;
		case "toolLine":
			if (value === "attach" || value === "own" || value === "off") {
				settings.toolLine = value;
				return true;
			}
			return false;
		case "stampColor":
			if ((STAMP_COLORS as readonly string[]).includes(value)) {
				settings.stampColor = value as StampColor;
				return true;
			}
			return false;
	}
}

function displayValue(value: boolean | string | number): string {
	return typeof value === "boolean" ? (value ? "on" : "off") : String(value);
}

// ---------------------------------------------------------------------------
// Stamp data (persisted in the session file, re-rendered on demand)
// ---------------------------------------------------------------------------

interface StampUsage {
	input: number;
	output: number;
	reasoning?: number;
	cacheRead: number;
	cacheWrite?: number;
	totalTokens: number;
}

/** One tool result waiting for the stamp line it should attach to. */
interface PendingTool {
	/** toolCallId, so a finished tool can be matched with the message carrying its output. */
	id: string;
	/** When the tool run started. */
	ts: number;
	name: string;
	ok: boolean;
	/** Wall time of the tool run itself. */
	durMs: number;
	errText?: string;
}

interface StampLiteData {
	v: number;
	kind: "user" | "assistant" | "tool" | "compaction";
	/** Stamp time in ms. For messages: the message timestamp. */
	ts: number;
	/** Previous stamp time, used for date context. */
	prevTs?: number;
	/** Assistant: request start (Pi's message timestamp). */
	t0?: number;
	/** Assistant: first streamed content observed. */
	firstAt?: number;
	/** Assistant: stream end. */
	endAt?: number;
	usage?: StampUsage;
	stop?: string;
	error?: boolean;
	/** Error text, whitespace collapsed, capped at STORED_ERROR_CHARS. */
	errText?: string;
	/** Context tokens: prompt (including cached) + generated, i.e. KV cache size. */
	ctxTokens?: number;
	/** User line: estimated tokens of the message that was sent. */
	userIn?: number;
	/** Assistant, attached tool info: tools that ran right before this call. */
	tools?: string[];
	/** Assistant, attached tool info: false when any of those tools failed. */
	toolOk?: boolean;
	/** Tool line (`toolLine: "own"`): tool name, duration, outcome. */
	tool?: string;
	durMs?: number;
	ok?: boolean;
	/** Compaction: context size that was compacted away. */
	tokensBefore?: number;
	/** Compaction: estimated context size left after it (chars/4, no system prompt). */
	ctxAfter?: number;
	/** Compaction: what triggered it (`manual` | `threshold` | `overflow`). */
	reason?: string;
}

function isStampData(value: unknown): value is StampLiteData {
	if (!isRecord(value)) return false;
	return typeof value.v === "number" && value.v >= 1 &&
		(value.kind === "user" || value.kind === "assistant" || value.kind === "tool" || value.kind === "compaction") &&
		typeof value.ts === "number";
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function int(n: number): string {
	return Math.round(n).toLocaleString("en-US");
}

function clock(ts: number, settings: StampLiteSettings): string {
	const date = new Date(ts);
	if (Number.isNaN(date.getTime())) return "";
	const h24 = date.getHours();
	const hour = settings.hourCycle === "12h" ? ((h24 + 11) % 12) + 1 : h24;
	const pad = (n: number) => String(n).padStart(2, "0");
	let text = `${pad(hour)}:${pad(date.getMinutes())}`;
	if (settings.showSeconds) text += `:${pad(date.getSeconds())}`;
	if (settings.hourCycle === "12h") text += h24 < 12 ? " AM" : " PM";
	return text;
}

function dateTag(ts: number): string {
	const date = new Date(ts);
	return `${date.toLocaleString("en-US", { month: "short" })} ${date.getDate()}`;
}

function duration(ms: number): string {
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) {
		const seconds = Math.round((ms % 60_000) / 1000);
		return seconds === 60 ? `${minutes + 1}m 00s` : `${minutes}m ${String(seconds).padStart(2, "0")}s`;
	}
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Tokens per second, labelled PP (prompt processing) or TG (token generation). */
function rate(label: string, tokens: number, ms: number): string {
	if (tokens <= 0 || ms <= 0) return "";
	const tps = (tokens * 1000) / ms;
	return `${label} ${tps >= 100 ? int(tps) : tps.toFixed(1)} t/s`;
}

/** Leading characters of a string, counted in characters not UTF-16 units. */
function clip(text: string, maxChars: number): string {
	const chars = Array.from(text);
	if (chars.length <= maxChars) return text;
	return `${chars.slice(0, maxChars).join("")}…`;
}

function textFromPayload(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(textFromPayload).filter(Boolean).join(" ");
	if (isRecord(value)) {
		if (typeof value.text === "string") return value.text;
		if (typeof value.errorMessage === "string") return value.errorMessage;
		if (value.error !== undefined) return textFromPayload(value.error);
		if (value.content !== undefined) return textFromPayload(value.content);
	}
	return "";
}

/** Flatten an error payload into one bounded plain-text line for storage. */
function errorText(value: unknown): string {
	const plain = textFromPayload(value).replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim();
	return Array.from(plain).slice(0, STORED_ERROR_CHARS).join("");
}

/** Rough token count of a user message, using Pi's own chars/4 heuristic. */
function estimateContentTokens(content: unknown): number {
	if (typeof content === "string") return Math.ceil(content.length / CHARS_PER_TOKEN);
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") chars += block.text.length;
		else if (block.type === "image") chars += IMAGE_CHARS;
	}
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** True when the stamp describes something that went wrong (ERROR, not WARNING). */
function failedStamp(data: StampLiteData): boolean {
	if (data.kind === "tool") return data.ok === false;
	return data.error === true || data.toolOk === false;
}

/**
 * Result marker at the end of the line: `ERROR: <text>` for a failing tool or a failed
 * call, `OK` when a tool ran successfully, the stop reason in capitals for an abnormal
 * finish (e.g. `ABORTED`). Nothing for a plain successful answer.
 */
function statusText(data: StampLiteData, settings: StampLiteSettings): string | undefined {
	if (failedStamp(data)) {
		const text = data.errText ?? "";
		if (!text || settings.errorTextChars <= 0) return "ERROR";
		return `ERROR: ${clip(text, settings.errorTextChars)}`;
	}
	// An abnormal stop wins over the tool/compaction OK marker: a call that was cut short is
	// not a success even when a tool did run inside it.
	if (data.stop !== undefined && !NORMAL_STOPS.has(data.stop)) return data.stop.toUpperCase();
	if (data.kind === "tool" || data.kind === "compaction" || (data.tools?.length ?? 0) > 0) return "OK";
	return undefined;
}

interface Part {
	text: string;
	/** Lower priority is dropped first when the line does not fit. */
	prio: number;
}

/** `bash` or `edit, bash +2` for the tools that ran before this call. */
function toolLabel(data: StampLiteData): string | undefined {
	const names = data.kind === "tool" ? (data.tool === undefined ? [] : [data.tool]) : (data.tools ?? []);
	if (names.length === 0) return undefined;
	const shown = names.slice(0, TOOL_NAMES_SHOWN).join(", ");
	return names.length > TOOL_NAMES_SHOWN ? `${shown} +${names.length - TOOL_NAMES_SHOWN}` : shown;
}

/** `Compaction`, `Compaction (auto)` or `Compaction (overflow)`. */
function compactionLabel(data: StampLiteData): string {
	if (data.reason === "overflow") return "Compaction (overflow)";
	if (data.reason === "threshold") return "Compaction (auto)";
	return "Compaction";
}

/** `Ctx 100,318 → ~46,900`: what was compacted away and roughly what is left. */
function ctxSpan(data: StampLiteData): string {
	const before = int(data.tokensBefore ?? 0);
	return data.ctxAfter !== undefined && data.ctxAfter > 0
		? `Ctx ${before} → ~${int(data.ctxAfter)}`
		: `Ctx ${before}`;
}

/** Normalise a usage report from Pi into the shape stored in a stamp. */
function stampUsageOf(raw: unknown): StampUsage | undefined {
	if (!isRecord(raw)) return undefined;
	const num = (value: unknown): number => Number(value) || 0;
	return {
		input: num(raw.input),
		output: num(raw.output),
		...(raw.reasoning === undefined ? {} : { reasoning: num(raw.reasoning) }),
		cacheRead: num(raw.cacheRead),
		...(raw.cacheWrite === undefined ? {} : { cacheWrite: num(raw.cacheWrite) }),
		totalTokens: num(raw.totalTokens),
	};
}

/** ISO timestamp -> ms, undefined when absent or unparseable. */
function isoMs(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Context size left after a compaction. Pi's own getContextUsage() returns null until an
 * assistant answer arrives after the compaction boundary, so this is the only number to be
 * had at that moment: the same chars/4 estimate Pi uses, over the entries that now form the
 * context (summary plus kept messages). It excludes system prompt and tool schemas, hence
 * the `~` in the rendered line.
 */
function estimateAfterContext(sessionManager: ExtensionContext["sessionManager"]): number | undefined {
	try {
		let total = 0;
		for (const entry of sessionManager.buildContextEntries()) {
			for (const message of sessionEntryToContextMessages(entry)) total += estimateTokens(message as never);
		}
		return total > 0 ? total : undefined;
	} catch {
		return undefined;
	}
}

/** Context tokens of a stamp: stored value, else computed from the usage report. */
function ctxTokensOf(data: StampLiteData): number {
	if (data.ctxTokens !== undefined && data.ctxTokens > 0) return data.ctxTokens;
	const usage = data.usage;
	if (!usage) return 0;
	return usage.totalTokens > 0
		? usage.totalTokens
		: usage.input + usage.output + usage.cacheRead + (usage.cacheWrite ?? 0);
}

/** Clock, plus a date tag when the previous stamp was on another day. */
function stampText(data: StampLiteData, settings: StampLiteSettings): string {
	const stamp = clock(data.ts, settings);
	const showDate =
		settings.showDate &&
		data.prevTs !== undefined &&
		new Date(data.prevTs).toDateString() !== new Date(data.ts).toDateString();
	return showDate ? `${dateTag(data.ts)} ${stamp}` : stamp;
}

function buildParts(data: StampLiteData, settings: StampLiteSettings): Part[] {
	const parts: Part[] = [];
	const stamp = stampText(data, settings);
	if (!stamp) return [];
	parts.push({ text: stamp, prio: 100 });

	const isTool = data.kind === "tool";

	if (data.kind === "compaction") {
		// time · duration · Compaction · In · Out · Cache · TG · PP · Ctx before → after · result
		const cu = data.usage;
		if (settings.showDuration && data.durMs !== undefined && data.durMs >= 0) {
			parts.push({ text: duration(data.durMs), prio: 93 });
		}
		parts.push({ text: compactionLabel(data), prio: 96 });
		if (cu?.input && settings.showTokensIn) parts.push({ text: `In ${int(cu.input)}`, prio: 62 });
		if (cu?.output && settings.showTokensOut) parts.push({ text: `Out ${int(cu.output)}`, prio: 66 });
		if (cu?.reasoning && settings.showReasoning) parts.push({ text: `Think ${int(cu.reasoning)}`, prio: 45 });
		if (cu?.cacheRead && settings.showCache) parts.push({ text: `Cache ${int(cu.cacheRead)}`, prio: 30 });
		// The summary request is not streamed to extensions, so there is no first-token time:
		// both rates are averaged over the whole compaction instead of split into prefill and
		// generation as they are on an assistant line.
		const ms = data.durMs ?? 0;
		if (cu && ms > 0 && settings.showGenSpeed) {
			const text = rate("TG", cu.output, ms);
			if (text) parts.push({ text, prio: 40 });
		}
		if (cu && ms > 0 && settings.showPrefillSpeed) {
			const text = rate("PP", cu.input, ms);
			if (text) parts.push({ text, prio: 35 });
		}
		if (settings.showContext && (data.tokensBefore ?? 0) > 0) parts.push({ text: ctxSpan(data), prio: 50 });
		const cStatus = statusText(data, settings);
		if (cStatus) parts.push({ text: cStatus, prio: 98 });
		return parts;
	}

	if (data.kind === "user") {
		if (data.userIn !== undefined && data.userIn > 0 && settings.showTokensIn) {
			parts.push({ text: `In ${int(data.userIn)}`, prio: 60 });
		}
		if (data.ctxTokens !== undefined && data.ctxTokens > 0 && settings.showContext) {
			parts.push({ text: `Ctx ${int(data.ctxTokens)}`, prio: 50 });
		}
		return parts;
	}

	const t0 = data.t0 ?? data.ts;
	const endAt = data.endAt ?? data.ts;
	const usage = data.usage;

	// time · duration · In · Out · Think · Cache · TG · PP · Ctx · tool · result
	const durMs = settings.showDuration
		? isTool ? data.durMs : (endAt >= t0 ? endAt - t0 : undefined)
		: undefined;
	if (durMs !== undefined && durMs >= 0) parts.push({ text: duration(durMs), prio: 93 });

	if (!isTool) {
		if (usage?.input && settings.showTokensIn) parts.push({ text: `In ${int(usage.input)}`, prio: 62 });
		if (usage?.output && settings.showTokensOut) parts.push({ text: `Out ${int(usage.output)}`, prio: 66 });
		if (usage?.reasoning && settings.showReasoning) parts.push({ text: `Think ${int(usage.reasoning)}`, prio: 45 });
		if (usage?.cacheRead && settings.showCache) parts.push({ text: `Cache ${int(usage.cacheRead)}`, prio: 30 });
		if (usage && settings.showGenSpeed && data.firstAt !== undefined) {
			const text = rate("TG", usage.output, endAt - data.firstAt);
			if (text) parts.push({ text, prio: 40 });
		}
		if (usage && settings.showPrefillSpeed && data.firstAt !== undefined) {
			const text = rate("PP", usage.input, data.firstAt - t0);
			if (text) parts.push({ text, prio: 35 });
		}
		const ctxTokens = ctxTokensOf(data);
		if (ctxTokens > 0 && settings.showContext) parts.push({ text: `Ctx ${int(ctxTokens)}`, prio: 50 });
	}

	const tool = toolLabel(data);
	if (tool) parts.push({ text: tool, prio: 94 });
	const status = statusText(data, settings);
	if (status) parts.push({ text: status, prio: 98 });
	return parts;
}

function truncateToWidth(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	let out = "";
	let used = 0;
	for (const character of text) {
		const cw = visibleWidth(character);
		if (used + cw > width - 1) break;
		out += character;
		used += cw;
	}
	return `${out}…`;
}

function oneLine(parts: readonly Part[], width: number): string {
	const chosen = parts.slice().sort((a, b) => b.prio - a.prio);
	for (let drop = 0; drop < chosen.length; drop += 1) {
		const keep = chosen.slice(0, chosen.length - drop).sort((a, b) => parts.indexOf(a) - parts.indexOf(b));
		const line = keep.map((part) => part.text).join(" · ");
		if (visibleWidth(line) <= width || chosen.length - drop === 1) return line;
	}
	return "";
}

/** Narrow-terminal fallback: clock, tool name, and as much error text as fits. */
function errorLine(data: StampLiteData, settings: StampLiteSettings, width: number): string {
	const stamp = stampText(data, settings);
	const label = toolLabel(data);
	const withTool = label ? ` · ${label}` : "";
	const full = `${stamp}${withTool} · ERROR`;
	if (visibleWidth(full) + 3 > width) return `${stamp} · ERROR`;
	const text = settings.errorTextChars > 0 ? data.errText ?? "" : "";
	if (!text) return full;
	const budget = Math.min(settings.errorTextChars, width - visibleWidth(full) - 3);
	if (budget < 4) return full;
	return `${full}: ${clip(text, budget)}`;
}

/** Stamp line, but a failing entry never loses its ERROR marker to field dropping. */
function stampLine(data: StampLiteData, settings: StampLiteSettings, width: number): string {
	const line = oneLine(buildParts(data, settings), width);
	const failed = failedStamp(data);
	if (!failed || line.includes("ERROR")) return line;
	return errorLine(data, settings, width);
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

function createRenderer(getSettings: () => StampLiteSettings): EntryRenderer<StampLiteData> {
	return (entry: CustomEntry<StampLiteData>, _options, theme): Component | undefined => {
		const data = entry.data;
		if (!isStampData(data)) return undefined;
		const settings = getSettings();
		if (data.kind === "user" && !settings.userLine) return undefined;
		// Stand-alone tool lines are gone unless asked for; this also hides the entries
		// written by older versions of the extension.
		if (data.kind === "tool" && settings.toolLine !== "own") return undefined;
		return {
			render(width: number): string[] {
				if (width < 4) return [];
				const line = truncateToWidth(stampLine(data, settings, width), width);
				if (!line) return [];
				return [theme.fg(settings.stampColor, line)];
			},
			invalidate() {},
		};
	};
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

interface TimingObservation {
	t0: number;
	firstAt?: number;
}

/** A stamp waiting to be written, in creation order. */
export default function stampLiteExtension(pi: ExtensionAPI): void {
	let settings = DEFAULTS;
	const reloadSettings = (): string[] => {
		const loaded = loadSettings();
		settings = loaded.settings;
		return loaded.issues;
	};

	let lastStampTs: number | undefined;
	const active = new Map<number, TimingObservation>();
	const activeTools = new Map<string, number>();
	/** Set by session_before_compact; consumed by session_compact / session_compact_failed. */
	let compactionStart: { t0: number; reason: string; tokensBefore?: number } | undefined;
	const pendingTools: PendingTool[] = [];
	let appendedThisMessage = new Set<number>();

	/** Stamps in creation order, written at the start of a later event handler. */
	const queue: { stamp: StampLiteData; hold: number }[] = [];
	let appending = false;

	/**
	 * Pi renders and persists a message *after* the extension handler for that message returns,
	 * so a stamp appended inside that handler lands above the entry it describes. The start of
	 * the next handler is the point where the described entry is on screen and nothing newer has
	 * been added yet. A timer cannot do this: a fast-following user prompt gets rendered first,
	 * which is what used to drop an answer's stamp under the next prompt.
	 */
	const flush = (): void => {
		if (appending) return;
		appending = true;
		try {
			// Items with hold > 0 wait one more event: an interrupted message is rewritten by Pi
			// after its own message_end, so its stamp has to wait an extra step to follow it.
			while (queue.length > 0) {
				const head = queue[0]!;
				if (head.hold > 0) {
					head.hold -= 1;
					break;
				}
				queue.shift();
				pi.appendEntry<StampLiteData>(ENTRY_TYPE, head.stamp);
			}
		} finally {
			appending = false;
		}
	};

	const queueStamp = (data: Omit<StampLiteData, "v" | "prevTs">, hold = 0): void => {
		const stamp: StampLiteData = {
			v: STAMP_VERSION,
			...(lastStampTs === undefined ? {} : { prevTs: lastStampTs }),
			...data,
		};
		// Reserve the chain position now; the queue is written in this same order.
		lastStampTs = data.ts;
		queue.push({ stamp, hold });
	};

	const clearQueue = (): void => {
		queue.length = 0;
	};

	pi.registerEntryRenderer(ENTRY_TYPE, createRenderer(() => settings));
	pi.registerEntryRenderer(LEGACY_ENTRY_TYPE, createRenderer(() => settings));   // old-session stamps still render

	const summary = (): string => {
		const on = (Object.keys(DEFAULTS) as (keyof StampLiteSettings)[])
			.map((key) => {
				const value = settings[key];
				if (typeof value === "boolean") return value ? key : undefined;
				return `${key}=${value}`;
			})
			.filter((part): part is string => part !== undefined)
			.join(", ");
		return `pi-stamp-plus on: ${on} · config: ${join(getAgentDir(), SETTINGS_FILE)}`;
	};

	const commit = (ctx: ExtensionCommandContext, message: string): void => {
		try {
			saveSettings(settings);
			ctx.ui.notify(`${message} · saved`, "info");
		} catch (error) {
			ctx.ui.notify(`could not write ${SETTINGS_FILE}: ${(error as Error).message}`, "error");
		}
	};

	/** Interactive picker: one entry per setting, current value in the label. */
	const menu = async (ctx: ExtensionCommandContext): Promise<void> => {
		for (;;) {
			const labels = FIELD_LABELS.map(([key, label]) => `${label}: ${displayValue(settings[key])}`);
			const choice = await ctx.ui.select("pi-stamp-plus — change a setting", [...labels, "done"]);
			if (choice === undefined || choice === "done") return;
			const index = labels.indexOf(choice);
			if (index < 0) return;
			const [key, label] = FIELD_LABELS[index]!;

			if (BOOLEAN_KEYS.includes(key as BooleanKey)) {
				const boolKey = key as BooleanKey;
				settings[boolKey] = !settings[boolKey];
				commit(ctx, `${label} → ${settings[boolKey] ? "on" : "off"}`);
				continue;
			}
			if (key === "errorTextChars") {
				const text = await ctx.ui.input("error text characters (0-500)", String(settings.errorTextChars));
				if (text === undefined) continue;
				const value = Number(text.trim());
				if (!Number.isFinite(value) || value < 0 || value > ERROR_TEXT_CHARS_MAX) {
					ctx.ui.notify(`needs a number from 0 to ${ERROR_TEXT_CHARS_MAX}`, "warning");
					continue;
				}
				settings.errorTextChars = Math.floor(value);
				commit(ctx, `${label} → ${settings.errorTextChars}`);
				continue;
			}
			const enumKey = key as EnumKey;
			const picked = await ctx.ui.select(label, [...ENUM_KEYS[enumKey]]);
			if (picked !== undefined && setEnum(settings, enumKey, picked)) commit(ctx, `${label} → ${picked}`);
		}
	};

	pi.registerCommand("stamp-lite", {
		description: "Change pi-stamp-plus settings (no argument = menu, or: status | <field> [value])",
		handler: async (args, ctx) => {
			const problems = reloadSettings();
			if (problems.length) ctx.ui.notify(problems.slice(0, 3).join(" | "), "warning");
			const words = args.trim().split(/\s+/).filter(Boolean);
			if (words.length === 0) {
				if (ctx.mode === "tui") await menu(ctx);
				else ctx.ui.notify(summary(), "info");
				return;
			}
			const head = words[0]!.toLowerCase();
			if (head === "status") {
				ctx.ui.notify(summary(), "info");
				return;
			}
			if (head === "menu") {
				if (ctx.mode === "tui") await menu(ctx);
				else ctx.ui.notify("the settings menu needs the interactive terminal (pi in TUI mode)", "info");
				return;
			}
			const key = ALIASES[head];
			if (key === undefined) {
				ctx.ui.notify(`unknown field "${words[0]}" — try /stamp-lite (menu) or /stamp-lite status`, "warning");
				return;
			}
			const wanted = words[1];
			if (BOOLEAN_KEYS.includes(key as BooleanKey)) {
				const boolKey = key as BooleanKey;
				settings[boolKey] = wanted === undefined
					? !settings[boolKey]
					: !(wanted === "off" || wanted === "false" || wanted === "0");
				commit(ctx, `${key} → ${settings[boolKey] ? "on" : "off"}`);
				return;
			}
			if (key === "errorTextChars") {
				const value = Number(wanted);
				if (wanted === undefined || !Number.isFinite(value) || value < 0 || value > ERROR_TEXT_CHARS_MAX) {
					ctx.ui.notify(`errorTextChars needs a number from 0 to ${ERROR_TEXT_CHARS_MAX} (now ${settings.errorTextChars})`, "warning");
					return;
				}
				settings.errorTextChars = Math.floor(value);
				commit(ctx, `errorTextChars → ${settings.errorTextChars}`);
				return;
			}
			const enumKey = key as EnumKey;
			if (wanted === undefined) {
				ctx.ui.notify(`${key} is ${String(settings[enumKey])} — values: ${ENUM_KEYS[enumKey].join(", ")}`, "info");
				return;
			}
			if (!setEnum(settings, enumKey, wanted)) {
				ctx.ui.notify(`${key} must be one of ${ENUM_KEYS[enumKey].join(", ")}`, "warning");
				return;
			}
			commit(ctx, `${key} → ${wanted}`);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const problems = reloadSettings();
		lastStampTs = undefined;
		active.clear();
		activeTools.clear();
		pendingTools.length = 0;
		appendedThisMessage = new Set();
		compactionStart = undefined;
		clearQueue();
		if (problems.length) ctx.ui.notify(problems.slice(0, 3).join(" · "), "warning");
	});

	// Tools of an aborted turn must not attach to the next turn's first stamp line.
	pi.on("turn_start", () => {
		flush();
		pendingTools.length = 0;
	});

	pi.on("message_start", (event) => {
		flush();
		if (event.message.role !== "assistant") return;
		const t0 = event.message.timestamp;
		if (typeof t0 !== "number" || !Number.isFinite(t0)) return;
		if (active.size >= MAX_ACTIVE_MESSAGES) active.clear();
		active.set(t0, { t0 });
	});

	pi.on("message_update", (event) => {
		flush();
		if (event.message.role !== "assistant") return;
		const observation = active.get(event.message.timestamp);
		if (!observation || observation.firstAt !== undefined) return;
		if (FIRST_CONTENT_EVENTS.has(event.assistantMessageEvent.type)) observation.firstAt = Date.now();
	});

	pi.on("message_end", (event, ctx) => {
		flush();
		if (event.message.role === "user") {
			const ts = event.message.timestamp;
			if (typeof ts !== "number" || !Number.isFinite(ts)) return;
			const userIn = estimateContentTokens(event.message.content);
			// Pi's own context estimate, which already includes the message just sent.
			const used = ctx.getContextUsage?.()?.tokens;
			queueStamp({
				kind: "user",
				ts,
				...(userIn > 0 ? { userIn } : {}),
				...(used !== undefined && used !== null && used > 0 ? { ctxTokens: used } : {}),
			});
			return;
		}
		if (event.message.role === "toolResult") {
			// "own" mode: the tool gets its own line, written now so it lands after the tool
			// output. "attach" leaves the finished tools queued for the next answer's stamp.
			if (settings.toolLine === "own") {
				for (let i = 0; i < pendingTools.length; i += 1) {
					const tool = pendingTools[i]!;
					if (tool.id !== event.message.toolCallId) continue;
					pendingTools.splice(i, 1);
					i -= 1;
					queueStamp({
						kind: "tool",
						ts: settings.stampTime === "end" ? tool.ts + tool.durMs : tool.ts,
						durMs: tool.durMs,
						tool: tool.name,
						ok: tool.ok,
						...(tool.errText === undefined ? {} : { errText: tool.errText }),
					});
				}
			}
			return;
		}
		if (event.message.role !== "assistant") return;
		const ts = event.message.timestamp;
		if (typeof ts !== "number" || !Number.isFinite(ts)) return;
		if (appendedThisMessage.has(ts)) return;
		appendedThisMessage.add(ts);

		const observation = active.get(ts);
		active.delete(ts);
		const endAt = Date.now();
		const errText = event.message.stopReason === "error" ? errorText(event.message.errorMessage ?? "") : "";
		const raw = event.message.usage as Partial<StampUsage> | undefined;
		const usage: StampUsage | undefined = raw
			? {
					input: Number(raw.input) || 0,
					output: Number(raw.output) || 0,
					...(raw.reasoning === undefined ? {} : { reasoning: Number(raw.reasoning) || 0 }),
					cacheRead: Number(raw.cacheRead) || 0,
					...(raw.cacheWrite === undefined ? {} : { cacheWrite: Number(raw.cacheWrite) || 0 }),
					totalTokens: Number(raw.totalTokens) || 0,
				}
			: undefined;

		// Context size of this call: prompt (including cached tokens) + generated tokens.
		const ctxTokens = usage
			? usage.totalTokens > 0
				? usage.totalTokens
				: usage.input + usage.output + usage.cacheRead + (usage.cacheWrite ?? 0)
			: 0;

		// Tools that ran without a stamp to attach to, unless they have their own lines.
		const tools = settings.toolLine === "attach" ? pendingTools.splice(0, pendingTools.length) : [];
		const toolFailed = tools.some((tool) => !tool.ok);
		// The assistant's own error text wins; otherwise show the first failing tool's text.
		const finalErrText = errText !== "" ? errText : tools.find((tool) => tool.errText !== undefined)?.errText ?? "";

		// An interrupted or failed call is rewritten by Pi shortly after its own message_end, so
		// its stamp waits one extra event and still lands below the message it describes.
		const interrupted = event.message.stopReason === "aborted" || event.message.stopReason === "error";
		queueStamp(
			{
				kind: "assistant",
				ts: settings.stampTime === "end" ? endAt : ts,
				t0: observation?.t0 ?? ts,
				...(observation?.firstAt === undefined ? {} : { firstAt: observation.firstAt }),
				endAt,
				...(usage === undefined ? {} : { usage }),
				...(ctxTokens > 0 ? { ctxTokens } : {}),
				...(tools.length === 0 ? {} : { tools: tools.map((tool) => tool.name) }),
				...(tools.length === 0 ? {} : { toolOk: !toolFailed }),
				...(event.message.stopReason === undefined ? {} : { stop: String(event.message.stopReason) }),
				...(event.message.stopReason === "error" ? { error: true } : {}),
				...(finalErrText === "" ? {} : { errText: finalErrText }),
			},
			interrupted ? 1 : 0,
		);
	});

	pi.on("tool_execution_start", (event) => {
		flush();
		if (activeTools.size >= MAX_ACTIVE_MESSAGES) activeTools.clear();
		activeTools.set(event.toolCallId, Date.now());
	});

	pi.on("tool_execution_end", (event) => {
		flush();
		const startedAt = activeTools.get(event.toolCallId);
		activeTools.delete(event.toolCallId);
		if (startedAt === undefined || settings.toolLine === "off") return;
		const durMs = Math.max(0, Date.now() - startedAt);
		const toolErrText = event.isError ? errorText(event.result) : "";
		// The tool's output message has not been persisted yet, so the tool is only remembered
		// here; the stamp is written when that message ends (own) or on the next answer (attach).
		if (pendingTools.length >= MAX_PENDING_TOOLS) pendingTools.shift();
		pendingTools.push({
			id: String(event.toolCallId ?? ""),
			name: String(event.toolName ?? "tool"),
			ok: !event.isError,
			durMs,
			...(toolErrText === "" ? {} : { errText: toolErrText }),
			ts: startedAt,
		});
	});

	// A compaction summarises the session with its own LLM call that never appears as a
	// normal assistant message, so it gets a line of its own. The numbers are the real usage
	// the summary call reported, stored by Pi on the compaction entry.
	pi.on("session_before_compact", (event) => {
		flush();
		const before = event.preparation?.tokensBefore;
		compactionStart = {
			t0: Date.now(),
			reason: String(event.reason ?? "manual"),
			...(typeof before === "number" && before > 0 ? { tokensBefore: before } : {}),
		};
	});

	pi.on("session_compact", (event, ctx) => {
		const start = compactionStart;
		compactionStart = undefined;
		if (!settings.showCompaction) return;
		flush();
		const entry = event.compactionEntry;
		const endAt = Date.now();
		const t0 = start?.t0 ?? isoMs(entry.timestamp) ?? endAt;
		const usage = stampUsageOf(entry.usage);
		const tokensBefore = entry.tokensBefore ?? start?.tokensBefore;
		const after = estimateAfterContext(ctx.sessionManager);
		// The compaction entry is already persisted here, so this line can go in right away.
		queueStamp({
			kind: "compaction",
			ts: settings.stampTime === "end" ? endAt : t0,
			durMs: Math.max(0, endAt - t0),
			...(usage === undefined ? {} : { usage }),
			...(tokensBefore === undefined ? {} : { tokensBefore }),
			...(after === undefined ? {} : { ctxAfter: after }),
			...(start === undefined ? {} : { reason: start.reason }),
			stop: "stop",
		});
		flush();
	});

	pi.on("session_compact_failed", (event) => {
		const start = compactionStart;
		compactionStart = undefined;
		if (!settings.showCompaction) return;
		flush();
		const endAt = Date.now();
		const t0 = start?.t0 ?? endAt;
		const text = event.errorMessage === undefined ? "" : errorText(event.errorMessage);
		queueStamp({
			kind: "compaction",
			ts: settings.stampTime === "end" ? endAt : t0,
			durMs: Math.max(0, endAt - t0),
			...(start?.tokensBefore === undefined ? {} : { tokensBefore: start.tokensBefore }),
			...(start === undefined ? {} : { reason: start.reason }),
			stop: event.aborted ? "aborted" : "error",
			...(event.aborted ? {} : { error: true }),
			...(text === "" ? {} : { errText: text }),
		});
		flush();
	});

	pi.on("agent_end", () => {
		flush();
		active.clear();
		activeTools.clear();
		pendingTools.length = 0;
		appendedThisMessage = new Set();
		// compactionStart is deliberately kept: manual /compact aborts the agent first, whose
		// agent_end can arrive between session_before_compact and session_compact.
	});

	pi.on("session_shutdown", () => {
		flush();
		clearQueue();
		active.clear();
		activeTools.clear();
		pendingTools.length = 0;
		appendedThisMessage = new Set();
	});
}
