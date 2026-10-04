# pi-stamp-plus

Left-aligned, one-line-per-entry stamps in the Pi chat transcript, in yellow. No model name,
no thinking level, no estimated cost. Each stamp lands **under the entry it describes**, so an
answer or a tool run is followed by its own line; a tool run adds no extra line of its own.

Every line is `clock · duration · In · Out · Cache · TG · PP · Ctx · tool · result`:

```
22:52:04 · In 6 · Ctx 62,784
22:52:05 · 28.4s · In 3,486 · Out 1,874 · Cache 57,424 · TG 70.5 t/s · PP 1,981 t/s · Ctx 62,784
22:52:33 · 35.7s · In 101 · Out 584 · Cache 57,424 · TG 16.5 t/s · PP 240 t/s · Ctx 58,109
22:52:41 · 4.4s · In 84 · Out 241 · TG 18.9 t/s · PP 210 t/s · Ctx 58,350 · edit, bash · ERROR: /bin/sh: 1: nosuchprog: not found
23:10:07 · 48.2s · Compaction (auto) · In 63,667 · Out 15,500 · TG 321 t/s · PP 1,320 t/s · Ctx 100,318 → ~46,900 · OK
```

## Fields

| Field | Meaning |
|---|---|
| `22:52:05` | clock (start or end of the call, see `stampTime`) |
| `28.4s` | wall time of that LLM call (request start → stream end) |
| `In 3,486` | new (non-cached) prompt tokens sent in that call |
| `Out 1,874` | tokens generated in that call (includes reasoning) |
| `Think 900` | reasoning tokens inside `Out` (hidden unless `showReasoning`) |
| `Cache 62,108` | prompt tokens served from the prefix cache in that call |
| `TG 70.5 t/s` | **estimate** of token-generation (decode) speed for that call |
| `PP 1,981 t/s` | **estimate** of prompt-processing speed for that call |
| `Ctx 62,784` | context size: prompt (including cached) + generated — roughly what sits in the KV cache |
| `bash` | the tool(s) that ran just before this answer (see `toolLine`) |
| `OK` / `ERROR: …` | result of that tool batch or of the call itself |
| `Compaction (auto)` | this line is a compaction: `(auto)`, `(overflow)` or plain `(manual)` |

Where the lines land — one tool-using turn. Thinking, text and the tool call are blocks of
**one** assistant message, so that message gets one stamp line, directly under it and before
the tool output it asked for; the tool's name and outcome ride on the next stamp line:

(`toolLine: "own"` instead gives two lines per round trip — the speed line under the reply and
a `bash · 3.2s · OK` line under the tool output — but no stamp can sit *between* the answer text
and the tool-call card, because both are blocks of the same transcript entry.)

```
your prompt
                          ← blank line drawn by Pi above any extension entry
22:52:04 · In 6 · Ctx 62,784
answer text + tool call
22:52:33 · 35.7s · … · Ctx 58,109
  tool output
final answer text
22:52:41 · 4.4s · … · Ctx 58,350 · bash · OK
```

Pi always draws one blank line above a custom entry (`CustomEntryComponent` in Pi adds a
`Spacer(1)`; its own comment says the host owns transcript spacing). An extension cannot
remove that spacer, so every stamp comes with one blank line above it. Turn `userLine` off
if you want one stamp line per exchange instead of two.

Other cases:

- **compaction** — one line, written when the summarising call finishes, with the usage that
  call reported (Pi stores it on the compaction entry): `In` is the context that was read to
  produce the summary, `Out` the summary itself, and `Ctx 100,318 → ~46,900` the context
  before compaction and roughly what is left after it. The `~` number is an estimate: Pi
  reports real context usage only once an answer arrives after the compaction. Speeds on this
  line are averaged over the whole compaction (the summary request is not streamed to
  extensions, so there is no first-token time to split prefill from generation).
  Turn `showCompaction` off to drop the line. A compaction that failed ends with
  `ERROR: <reason>`, a cancelled one with `ABORTED`.
- **tool result** — by default attached to the end of the stamp line of the answer that
  follows the tool output (`… · bash · OK` or `… · bash · ERROR: <first characters of the error>`); a batch reads
  `edit, bash · OK` (`+N` when more than three tools ran). ANSI colours and newlines in the
  tool output are stripped before display; the number of characters is `errorTextChars`
  (default 50, `0` prints `ERROR` alone). The tool's own duration is not shown — that time is
  inside the wall time of the call.
- **failed assistant call** — ends with `ERROR: <errorMessage from the provider>`.
- **abnormal finish** — the stop reason in capitals, e.g. `ABORTED` (Esc-cancelled call).
- **user line** — `22:52:04 · In 6 · Ctx 62,784`: `In` is the size of the message you sent
  (Pi's own chars ÷ 4 estimate, images counted as 4,800 characters), `Ctx` is Pi's current
  context usage including that message. Plus a `Sep 18` date tag on the first entry of a new day.

## Why PP and TG are estimates

Pi talks to the model through the OpenAI-compatible chat-completions API. That API
returns token **counts** (`usage`) but no llama.cpp `timings` block (`prompt_ms`,
`predicted_ms`, `prompt_per_second`, `predicted_per_second`). Those numbers exist only on
llama.cpp's own `/completion` (and `timings: true`) path, and neither Pi nor
`pi-llama-cpp` exposes them to extensions. So the rates are computed from timestamps Pi
does expose:

- `PP` = new prompt tokens ÷ (first streamed content − request start). Includes HTTP
  overhead, server queue time and first-token sampling, so it reads a bit lower than the
  server's own `prompt_per_second`. When most of the prompt is a cache hit, `In` is small
  while the wait stays short — the rate can look high.
- `TG` = output tokens ÷ (stream end − first streamed content). This one is close to the
  real decode rate; usage counts arrive in the final SSE chunk
  (`stream_options.include_usage`), so it can only be computed once the call ends. With a
  two-token answer the number is meaningless — read it on real-length answers.

Everything else (tokens, durations) comes straight from Pi's usage report.
`Ctx` is `usage.totalTokens` of that one call, i.e. `input + cacheRead + cacheWrite + output`:
the prompt Pi actually sent (cached tokens included) plus what the model generated. That is
the live context, the same basis Pi's own context indicator uses. It is **not** a session sum
— each line shows the context at that moment, so the last line shows where the context ended.

## Location and install

The extension lives in the global Pi extensions folder and is picked up automatically:

```
~/.pi/agent\extensions\pi-stamp-plus\
```

Nothing to install — `/reload` (or restarting Pi) is enough. To remove it, delete that
folder and `/reload`. If the full `pi-stamp` package is installed at the same time you get
two stamps, so remove it with `pi remove npm:@narumitw/pi-stamp`.

## Config

`~/.pi/agent\pi-stamp-plus.json` — read at startup, re-read at session start
and on `/stamp-lite`. Unknown or wrong-typed values fall back to the default and Pi shows a
one-line warning.

```json
{
  "hourCycle": "24h",
  "stampTime": "start",
  "showSeconds": true,
  "showDate": true,
  "userLine": true,
  "toolLine": "attach",
  "showCompaction": true,
  "showDuration": true,
  "showPrefillSpeed": true,
  "showGenSpeed": true,
  "showTokensIn": true,
  "showTokensOut": true,
  "showReasoning": false,
  "showCache": true,
  "showContext": true,
  "stampColor": "warning",
  "errorTextChars": 50
}
```

| Key | Default | Effect |
|---|---|---|
| `hourCycle` | `"24h"` | `"24h"` or `"12h"` clock |
| `stampTime` | `"start"` | clock shows the start or the end of assistant/tool work |
| `showSeconds` | `true` | `HH:MM:SS` vs `HH:MM` |
| `showDate` | `true` | add a `Sep 18` tag on the first entry of a new day |
| `userLine` | `true` | stamp under your messages |
| `toolLine` | `"attach"` | `"attach"` = tool name + outcome on the next stamp line, `"own"` = a line of its own directly under the tool's output (name, how long the tool ran, `OK`/`ERROR`), `"off"` = nothing. Old `true`/`false` still load, mapped to `own`/`off` with a warning |
| `showCompaction` | `true` | one line per compaction (manual, auto, overflow) with the summary call's real usage |
| `showDuration` | `true` | `28.4s` |
| `showPrefillSpeed` | `true` | `PP … t/s` |
| `showGenSpeed` | `true` | `TG … t/s` |
| `showTokensIn` | `true` | `In …` |
| `showTokensOut` | `true` | `Out …` |
| `showReasoning` | `false` | `Think …` (reasoning tokens, a subset of `Out`) |
| `showCache` | `true` | `Cache …` |
| `showContext` | `true` | `Ctx …` (context / KV-cache size of that call) |
| `stampColor` | `"warning"` | theme colour of the whole line: `warning` (yellow in the built-in themes), `accent`, `success`, `error`, `text`, `muted`, `dim`, `toolTitle`, `customMessageLabel` |
| `errorTextChars` | `50` | characters of error text after `ERROR:` (`0` = label only, max 500) |

### `/stamp-lite` — settings

- **`/stamp-lite`** (no argument, in the terminal) opens a menu: one row per setting with its
  current value. Pick a row to toggle it, or to get a second picker for `clock`,
  `stamp time`, `tool info` and `colour`, or a text box for `error text chars`. Every change
  is written to `pi-stamp-plus.json` at once and reported as `colour → accent · saved`;
  pick `done` to close. Existing stamps redraw with the new settings on the next repaint.
- **`/stamp-lite status`** prints the active fields and the config path (this is also what
  you get when `/stamp-lite` is used outside the interactive terminal).
- **`/stamp-lite <field> [value]`** changes one setting directly, e.g.
  `/stamp-lite showCache off`, `/stamp-lite toolLine own`, `/stamp-lite colour accent`,
  `/stamp-lite errorchars 30`. A boolean field with no value flips; an unknown field or value
  warns and changes nothing. Field names are the config keys (lower-case matches work, plus
  the aliases `colour`, `tools`, `errorchars`).

### Narrow terminals

The stamp is always one line. If it does not fit, fields drop in this order:
`Cache`, `PP`, `TG`, `Think`, `Ctx`, `In`, `Out`. Clock, duration, tool name and the
result are kept; on a failing entry the renderer switches to
`clock · [tool ·] ERROR: <as much text as fits>` so an error is never lost.

## How it works

- Stamps are written with `pi.appendEntry()` from `message_end` / `tool_execution_end` and
  drawn by `pi.registerEntryRenderer()`. Custom entries are transcript-only: they are never
  sent to the model, so they cost no context tokens.
- Pi runs extension handlers **before** it renders and persists the message that triggered
  them, so a stamp written straight from `message_end` would land *above* that message — which
  is why earlier versions appeared to stamp tool calls but not answers. Stamps are therefore
  queued in creation order and appended at the start of the **next** event handler: the entry
  they describe is on screen by then, and nothing newer has been added yet. A timer cannot do
  this — a user prompt typed while the model is answering gets rendered first, and the stamp
  ends up under the wrong entry. `agent_end` and `session_shutdown` flush what is still queued,
  so no stamp is lost (not even for an Esc-cancelled call).
- Request start comes from `message.timestamp` (Pi sets it when the stream opens), first
  content from the first `text_*` / `thinking_*` / `toolcall_*` stream event, end from
  `message_end`.
- Error text comes from `AssistantMessage.errorMessage`, or from the tool result payload
  (`text` parts / `error` field). It is whitespace-collapsed, ANSI-stripped and stored
  capped at 300 characters; `errorTextChars` clips it further at display time, so changing
  that setting also re-displays older stamps.
- Compaction is stamped from `session_before_compact` (start time, `preparation.tokensBefore`,
  trigger) and `session_compact` / `session_compact_failed`. Registering a
  `session_before_compact` handler is also what makes Pi emit that event at all. This line is
  written immediately, not queued: by the time `session_compact` fires, the compaction entry is
  persisted and `agent.state.messages` already holds the post-compaction context, which is where
  the `~` after-value is estimated from (`buildContextEntries()` + Pi's own chars÷4 estimator).
- In `attach` mode a finished tool run rides on the next stamp line — the answer written after
  the tool output — because the line of the call itself is written before the tool has run.
  Pending tools are cleared on `turn_start`, `agent_end` and session start, so a tool from an
  aborted or replaced turn never attaches to the wrong answer. Stand-alone tool
  entries (including the ones written before `attach` existed) only render when
  `toolLine` is `"own"`, so switching modes never leaves a mix of both layouts. In `"own"` mode a
  tool that never produced a result message (interrupted mid-run) simply gets no line.
- A stamp is normally written at the next event handler after its own entry, which is the first
  moment that entry is already in the transcript and nothing newer is. An interrupted or failed
  call waits one extra event, because Pi rewrites the partial assistant message after its own
  `message_end`; without that the stamp would land above the very message it describes.
- The colour comes from the theme token (`theme.fg(settings.stampColor, …)`), so stamps follow
  the active theme rather than a hard-coded yellow.
- Stamps saved by older versions still render, and they get `Ctx` too: when a stored entry
  has no `ctxTokens`, the renderer recomputes it from the stored usage report.
- Stamps survive reload, `/tree` navigation and reopening a session, because they are
  stored in the session file.

## Development

```
npx tsc -p tsconfig.json                              # strict type check (also exactOptionalPropertyTypes)
node --experimental-strip-types --no-warnings dev/smoke.mjs
```

`dev/smoke.mjs` needs no model, no GPU and no network. It replays turns (plain answer, answer
after a tool, a two-tool batch with one failure, provider error, abort, manual/auto/failed
compaction, legacy v1 entries) and checks that one stamp lands per entry in transcript order —
in particular that a stamp queued by a message is written **before** a prompt that arrives
right after it, which is the race that used to put stamps under the wrong entry. It runs the
checks against several configs — `attach` / `own` / `off`, `showCompaction` off, reasoning on
and off, wide and 60-column widths — and drives the `/stamp-lite` command (argument form, menu
form, unknown field, menu outside a terminal) plus a broken config file, printing the resulting
lines with ANSI stripped.

There is no local node_modules: tsconfig `paths` maps `@earendil-works/*` into the
global Pi install (only for the local type check), and the smoke test stages a copy
with the imports rewritten to absolute paths. Pi injects its own copies at runtime.

## Not in this version

- Live tokens/second in the status line (next step: current TPS, 5-minute TPS,
  session-average TPS).
- Cost display (intentionally absent — local models always report `$0`).
- Per-tool token counts (tools do not produce model tokens; their tokens show up in the
  next assistant call's `In`).

> **Note on `tsconfig.json`:** it exists only for optional type-checking on the maintainer's machine
> (its `paths` entries point at the maintainer's global pi install). It is never used at runtime and
> does not affect loading, running, or installing this extension on another computer.
