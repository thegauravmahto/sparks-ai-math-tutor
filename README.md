# Livetutor — Sparks, the Live K12 Math Tutor

A realtime voice-to-voice math tutor for K-12 students (NCERT-aligned, EN/Hindi
code-switching). The student holds **SPACE**, speaks, releases, and Sparks
answers in real audio while building equations and diagrams on a whiteboard.

No pre-rendered videos. No STT/TTS pipeline. The browser streams raw 16 kHz mic
PCM straight to the **Gemini Live API**, which streams 24 kHz audio back. The
model also emits tool calls that render KaTeX, function plots, geometric
diagrams, and number lines on the page as Sparks talks.

## Stack

- **Gemini Live API** — `gemini-3.1-flash-live-preview`, native voice in/out,
  manual VAD with explicit `activity_start` / `activity_end` markers for
  push-to-talk, plus `input_audio_transcription` and
  `output_audio_transcription` for live captions.
- **FastAPI + uvicorn + WebSocket** — Python bridge between the browser and
  Gemini.
- **AudioWorklet** — Float32 mic samples → 16-bit PCM @ 16 kHz, 40 ms chunks.
- **Web Audio API** — contiguous 24 kHz playback queue with `AnalyserNode`
  amplitude → avatar mouth.
- **SVG avatar** — flat-illustration lady (warm gradient skin, two-tone hair,
  scoop-neck top, full lips with cupid's bow), mouth driven by audio RMS,
  blinking, mouse eye-tracking.
- **KaTeX** for equations, **function-plot.js** for 2D plots, **Rough.js** for
  hand-drawn geometric diagrams.

## Run locally

```bash
pip install -r requirements.txt
cp .env.example .env          # then paste your GEMINI_API_KEY
python server.py              # serves http://127.0.0.1:8765
```

Hold **SPACE** (or the **Hold** button) to talk. Release to send. Or type a
question into the input box and click **Send**.

Set `LOG_LEVEL=DEBUG` for verbose audio/event traces:

```bash
LOG_LEVEL=DEBUG python server.py
```

## UI layout

A 3-zone CSS grid in shadcn-style white theme:

```
┌────────────────────────────────────────────────────────┐
│  Topic · Class 8 · Step 3/5                  EN  LIVE  │
├──────────────────────────┬─────────────────────────────┤
│  PROBLEM (pinned)        │                             │
│  ─────────────────       │                             │
│                          │   WORKING WHITEBOARD        │
│  CONVERSATION (live      │   (KaTeX equations, hand-   │
│   transcripts both ways) │    drawn diagrams, plots,   │
│  👤 You: …               │    number lines)            │
│  ✨ Sparks: …            │                             │
│                          │                             │
├──────────────────────────┴───────────────────┬─────────┤
│  Type a question…   [Send]   SPACE  Hold     │ AVATAR  │
└──────────────────────────────────────────────┴─────────┘
```

Below 900 px the panels stack vertically and the avatar shrinks.

## Tools Sparks can call

### Layout / state
| Tool | Purpose |
|------|---------|
| `set_topic(title)` | Header banner |
| `set_problem(text, latex?, grade?)` | Pin the problem in the left panel |
| `set_step(current, total, title?)` | Step tracker (e.g. "Step 3/5 · Solve for x") |
| `set_language("en"\|"hi")` | Update the language pill |
| `clear_board()` | Wipe the whiteboard |
| `focus(label)` | Elevate one card to "current focus"; previous focus dims |
| `highlight(label)` | Flash any card to draw attention (~1.6 s) |

### High-level diagram templates (model only supplies semantics)
| Tool | Purpose |
|------|---------|
| `write_equation(latex, label)` | KaTeX equation card |
| `draw_triangle(sideA, sideB, sideC, rightAngleAt?, vertexLabels?, sideLabels?)` | SSS-derived triangle, hand-drawn (Rough.js), optional right-angle marker |
| `draw_coordinate_plane(xMin, xMax, yMin, yMax, points?, lines?, functions?)` | 2D plane with gridlines, points, line segments, function plots |
| `draw_unit_circle(angleDegrees?, showSinCos?)` | Unit circle + radius + angle arc + sine/cosine projection segments |
| `draw_parabola(a, b?, c?, showRoots?, showVertex?)` | Plots y = ax² + bx + c with auto-annotated roots and vertex |
| `draw_number_line(min, max, marks?, highlights?)` | Number line with ticks and shaded intervals |

### Primitives (escape hatches)
| Tool | Purpose |
|------|---------|
| `plot_function(expression, xMin, xMax, yMin, yMax, annotations?)` | Generic 2-D function plot |
| `draw_shapes(shapes, width?, height?)` | Freeform geometry (line, rect/square, circle, ellipse, polygon/triangle, polyline, point, text, arrow) |
| `draw_svg(svg)` | Raw SVG markup, sanitised |

## WebSocket protocol (browser ↔ server)

Both directions use the same WebSocket, mixing binary and JSON text frames.

### Browser → Server
- **binary** — 16 kHz / 16-bit mono PCM mic chunks (40 ms each).
- **text** — JSON control:
  - `{type:"ptt_start"}` → server fires `activity_start` at Gemini.
  - `{type:"ptt_end"}` → server fires `activity_end`.
  - `{type:"text", text:"…"}` → typed turn forwarded via `send_client_content`.
  - `{type:"tool_result", id, ok}` → ack of a server-forwarded tool call.
  - `{type:"client_log", level, msg}` → relays browser console messages so the
    Python terminal shows them as `[browser] …`.

### Server → Browser
- **binary** — 24 kHz / 16-bit mono PCM Gemini audio chunks.
- **text** — JSON control:
  - `{type:"status", text}` — status pill in the header.
  - `{type:"tool_call", id, name, args}` — forwarded function call to dispatch.
  - `{type:"transcript", role:"user"|"assistant", text, final}` — live caption
    chunks for the conversation panel.
  - `{type:"interrupt"}` — Gemini was interrupted; flush local playback and
    close the open transcript bubbles.
  - `{type:"turn_complete"}` — close transcript bubbles, return avatar to idle.

## Lip-sync, today

Amplitude-only. The browser pipes Gemini's PCM through a Web Audio
`AnalyserNode`, computes RMS each animation frame, and scales the SVG mouth
ellipse's `ry` from 0.7 (closed seam) to ~8 (wide open) inside a clip-path
that bounds it to the lip outline. No phoneme detection.

For viseme-based lip-sync, see "Roadmap" below — drop a Ready Player Me `.glb`
URL or a Rive `.riv` file and we'll wire up Three.js + `TalkingHead.js` or
`@rive-app/canvas` instead.

## Architecture diagram

While the server is running, open <http://127.0.0.1:8765/architecture> for an
inline-SVG high-level diagram showing the data flow across browser, FastAPI
bridge, and Gemini Live (binary PCM in red, JSON control in grey, tool calls
and transcripts in green, server↔Gemini in yellow).

## File layout

```
livetutor/
├── README.md              # this file
├── CLAUDE.md              # guide for AI agents working in this repo
├── architecture.html      # inline-SVG architecture diagram (served at /architecture)
├── requirements.txt
├── server.py              # FastAPI bridge: browser WS ↔ Gemini Live
├── .env.example
└── static/
    ├── index.html         # 3-zone CSS-grid shell + SVG avatar
    ├── style.css          # shadcn-style white theme
    ├── app.js             # mic capture, audio playback, tool dispatch,
    │                      # transcript bubbles, text input, log relay
    ├── avatar.js          # mouth scaling, blinking, eye tracking
    ├── pcm-worklet.js     # Float32 → Int16 16 kHz PCM encoder
    └── assets/
        └── avatar.json    # Lottie source (held for future viseme avatar)
```

## Environment

| Variable | Required | Purpose |
|----------|----------|---------|
| `GEMINI_API_KEY` | yes | Google AI Studio key — `.env` is loaded from `livetutor/.env` first, then the parent dir |
| `LOG_LEVEL` | no | `INFO` (default) or `DEBUG` for chunk-level traces |

## Known quirks

- **Session duration**: Gemini Live sessions cap at ~10–15 min and emit a
  `GoAway` close. Reload the tab to start a fresh session.
- **First reload after CSS edits**: Browsers cache aggressively. Use
  Cmd-Shift-R to force a fresh fetch.
- **ASGI race on tab close**: If the tab closes mid-turn, you'll occasionally
  see "Unexpected ASGI message 'websocket.send' after close" — harmless, the
  next session opens cleanly.
- **STEM only**: The system prompt is tuned for K-12 NCERT math; out-of-domain
  topics (e.g. programming concepts) work but the diagram tools won't fit.

## Roadmap

- Real viseme-based lip-sync via Ready Player Me + `TalkingHead.js`, Rive, or a
  VRM avatar with `three-vrm`. Drop a `.glb` / `.riv` and we'll wire it up.
- Wider K-12 coverage: physics force diagrams, biology cell labels, chemistry
  bond diagrams, electric-circuit primitives.
- Annotation overlay system: `annotate(target_label, at, text)` to draw arrows
  and labels onto an existing diagram in math coordinates.
- More language pills (Telugu, Tamil, Kannada, Marathi, Bengali, Gujarati).
- Auto-reconnect on Gemini Live `GoAway`.
