# CLAUDE.md — Guidance for AI agents working in this repo

This file is for *future Claude / agent sessions*. Read it before touching code.
The README is for humans; this is for orientation, common gotchas, and patterns
that aren't obvious from the diff.

## What this is

`livetutor/` is a single-file FastAPI server (`server.py`) that brokers a
browser WebSocket to the **Gemini Live API**. The browser captures mic audio,
streams it as raw PCM to the server, the server forwards it to Gemini, and
Gemini's streamed audio + tool calls flow back to the browser. The browser
renders KaTeX equations, hand-drawn diagrams (Rough.js), function plots
(function-plot.js), and a small SVG avatar whose mouth is driven by audio RMS.

## Run + iterate

```bash
pip install -r requirements.txt
python server.py                 # http://127.0.0.1:8765
LOG_LEVEL=DEBUG python server.py # adds chunk-level traces
```

The server has **no hot reload**. Restart on every Python change. The browser
caches CSS/JS aggressively — instruct the user to **hard reload** (Cmd-Shift-R)
after any frontend change, or you'll spend 20 minutes debugging code that
already works.

## How to debug visually without seeing the browser

The browser relays its own console (`[livetutor] …`) back over the WebSocket
as `{type:"client_log", level, msg}`, and the server prints those as
`[browser] …` lines. **Use this.** Every `tool →`, `card appended diagram-card
w=W h=H boardChildren=N`, and tool error shows up in the server log. If the
user reports "the diagram isn't showing", the answer is almost always either
in `[browser] tool error` (a JS bug in the renderer) or `[browser] card
appended … h=0` (CSS sizing). Don't ask the user to paste DevTools output;
ask them to run the action again and read the relayed log yourself.

## WebSocket protocol cheat-sheet

Browser → Server
- **binary** = 16 kHz mono Int16 PCM mic chunks (40 ms each).
- **text JSON** = `{type:"ptt_start"|"ptt_end"|"text"|"tool_result"|"client_log", …}`.

Server → Browser
- **binary** = 24 kHz mono Int16 PCM Gemini audio.
- **text JSON** = `{type:"status"|"tool_call"|"transcript"|"interrupt"|"turn_complete", …}`.

If you change either side, change the other. The relay code lives in
`server.py: ws_endpoint` and `app.js: handleServerMessage / dispatchTool`.

## Gemini Live gotchas (the painful ones)

1. **Auto-VAD vs manual VAD.** This project uses **manual VAD** because
   `gemini-3.1-flash-live-preview` rejected `audio_stream_end=True` with a
   1008 close ("Operation not implemented"). The fix was to set
   `realtime_input_config.automatic_activity_detection.disabled = True` and
   send `types.ActivityStart()` / `types.ActivityEnd()` around each PTT turn.
   **Do not** revert to auto-VAD without verifying the model still works.
2. **Session duration**: ~10–15 min, then `GoAway` → 1008 close. The error
   `pump_gemini_to_browser crashed … session error: 1008 None. Connection
   aborted because the client failed to close the connection after receiving
   a GoAway signal once the session duration…` is **expected**. Don't chase
   it; reload the tab.
3. **ASGI close race**: If the browser tab closes mid-turn,
   `pump_gemini_to_browser` will try to `ws.send_bytes()` on an already-closed
   socket and FastAPI raises `Unexpected ASGI message 'websocket.send' after
   sending 'websocket.close'`. Harmless, ignore.
4. **`tool_call` paths**: Function calls arrive as `response.tool_call.function_calls`
   at the top level. Some SDK versions also expose `function_call` on
   individual `model_turn.parts[i]` — the server logs both, but the canonical
   path is `response.tool_call`.
5. **Optimistic `FunctionResponse`**: For UI tools we send the
   `FunctionResponse(result:"ok")` back to Gemini *before* waiting for the
   browser to ack. The browser ack is logged separately for debugging but
   isn't on the critical path.

## Adding a new whiteboard tool

Three places must change in lockstep:

1. **`server.py` → `TOOLS` array**: add a `function_declarations` entry with a
   JSON Schema for parameters. Match the existing style (snake_case, required
   list, descriptions in plain English).
2. **`server.py` → `SYSTEM_PROMPT`**: add a one-line description under the
   appropriate section ("Layout tools", "High-level templates", "Primitives").
   Tell the model *when* to reach for it.
3. **`static/app.js` → `dispatchTool` switch + a renderer function**: build
   the DOM card, call `registerCard(label, card)` then `appendCard(card)`.
   Set width/height attributes on any SVG in addition to viewBox (some
   browsers collapse a viewBox-only SVG inside a flex column to 0 px tall —
   we hit this exact bug with `draw_triangle`).

If you forget step 3 the dispatcher silently sends `ok=true` (no exception)
and the user sees a blank board. If you forget step 1 the model never calls
the tool. If you forget step 2 the model rarely picks the right tool.

## Avatar

`static/index.html` contains a hand-crafted SVG **owl** avatar — body
ellipse (`url(#owlBody)` gradient), lighter belly (`url(#owlBelly)`),
beak and talon feet (`url(#beak)`), ear tufts, and **large round
black-framed glasses** (the two `r="32"` circles around the eyes at
cx=80 and cx=140). It is NOT a human portrait — earlier docs said
"flat-illustration lady" and that is wrong; the code is an owl. `avatar.js`
exposes two globals consumed by `app.js`:

- `setMouthAmplitude(0..1)` — drives mouth `ry` (clip-path bounds it to the
  lip outline). Computed from `AnalyserNode` RMS in `app.js → enqueuePCM`.
- `setAvatarTalking(bool)` — toggles a CSS class for slightly faster idle bob.

Eye-tracking and blink hooks rely on these specific element IDs/classes:
`#mouth`, `#tongue`, `#eyes .pupil`, `#eyes .glint`, `#eyes .eye-white`. If
you redesign the avatar, **keep these IDs/classes** or rewrite avatar.js too.

The user has rejected several avatar styles in the past (saree teacher,
kawaii mascot, default Lottie girl, even one minimal version). The current
shipped avatar is the bespectacled owl described above — be ready to iterate
but assume the owl is intentional, not a placeholder. For real **viseme**
lip-sync we need Ready Player Me + TalkingHead.js (or Rive). The
amplitude-only mouth is a placeholder and the user knows it.

## Layout (CSS grid)

`#app` is a 3-zone grid:
- header (full width, 56 px)
- left panel (380 px) = problem + transcript
- right panel = whiteboard
- HUD footer (full width, 80 px) = text input + PTT
- avatar = `position: fixed` bottom-right

Below 900 px the panels stack vertically. The shadcn-style white theme uses
zinc/slate neutrals (`#09090b` text, `#71717a` muted, `#e4e4e7` borders).
Don't introduce dark-theme styles — the user explicitly chose white.

## System-prompt rules that *must* stay

- **No narration without drawing.** Sparks must call a draw tool whenever
  she says she'll draw something. Removing this rule causes the "blank
  board" complaint within minutes.
- **K-12 NCERT alignment.** Indian classroom structure (Given → To Find →
  Solution → Answer), rupees/kilometres/lakhs, Hindi/English code-switching.
- **Templates over primitives.** Always prefer `draw_triangle`,
  `draw_coordinate_plane`, `draw_unit_circle`, `draw_parabola`,
  `draw_number_line`. Use `draw_shapes` only as fallback, `draw_svg` as
  last resort.

## Things that look like bugs but aren't

- 1008 / GoAway after ~10 min → session limit (#2 above).
- ASGI close race on tab reload → harmless (#3 above).
- `unknown shape type` warnings → the model occasionally picks shape types
  the renderer doesn't support (e.g. `pentagon`, `star`). Add the type to
  the `drawShapes` switch if it's a real omission, otherwise let it skip.
- Browser console shows old code after edits → user didn't hard-reload.

## Things that *are* bugs you should fix

- Any tool dispatch that causes `[browser] tool error` in the server log.
- `card appended … h=0` (renderer is producing a zero-height SVG).
- Server crash that **isn't** a 1008 GoAway or ASGI close-race — those
  indicate real protocol drift.

## When the user asks for something visual you can't see

Don't guess. Either:
1. Ask the user for a screenshot path (they often share `/var/folders/.../
   Screenshot ….png`), then `Read` the path — the harness will inline the
   image so you can see it.
2. Add temporary `[browser]` logs to confirm DOM state, then remove them
   when done.

## Conventions

- Imports / dependencies: keep small. We currently use `google-genai`,
  `fastapi`, `uvicorn`, `python-dotenv` server-side. Frontend uses CDN
  scripts (KaTeX, function-plot, Rough.js) — avoid adding npm/build steps.
- Logging: server uses Python `logging` (`log = logging.getLogger("livetutor")`).
  Browser uses `logInfo/logWarn/logError` which auto-relay. **Do not**
  `console.log` directly — it won't appear in the server terminal.
- File modifications: prefer `Edit` over `Write` for existing files.
- Commits: use HEREDOC for the message body, ending with the
  `Co-Authored-By: Claude …` line if you're using the bash flow.

## What's already shipped (don't redo)

- 3-zone CSS-grid layout with sticky problem + scrolling transcript.
- Manual-VAD push-to-talk + text-input lane + EN/Hindi language toggle.
- Live transcripts (input + output audio transcription).
- 12 whiteboard tools, including 4 K-12 templates with Rough.js rendering.
- Browser-console relay over WebSocket.
- Inline-SVG architecture diagram at `/architecture`.
- shadcn-style white theme.

## What's open

- Real viseme lip-sync (waiting for the user to choose RPM / Rive / VRM).
- Auto-reconnect on Gemini `GoAway`.
- Wider language pill (Telugu / Tamil / Kannada / Marathi / Bengali / Gujarati).
- Annotation overlay system (`annotate(target_label, at, text)`).
- Subject expansion beyond math (physics, biology, chemistry diagrams).
