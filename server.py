#!/usr/bin/env python3
"""Livetutor server — bridges a browser mic/speakers to Gemini Live.

Protocol between browser and this server:
  Browser -> Server:
    binary  : raw 16-bit PCM mono @ 16000 Hz (mic audio while push-to-talk held)
    text    : JSON control messages
              { "type": "ptt_end" }               # user released spacebar
              { "type": "tool_result", "id": "...", "ok": true }

  Server -> Browser:
    binary  : raw 16-bit PCM mono @ 24000 Hz (Gemini voice)
    text    : JSON control messages
              { "type": "tool_call", "id", "name", "args" }
              { "type": "status", "text": "..." }
              { "type": "interrupt" }   # model turn was interrupted
              { "type": "turn_complete" }
"""
import os
import sys
import json
import asyncio
import logging
import traceback
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from google import genai
from google.genai import types

# ---- logging ----
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("livetutor")

HERE = Path(__file__).parent
# Load .env from livetutor/ first, then fall back to parent dir for monorepo use.
load_dotenv(HERE / ".env")
load_dotenv(HERE.parent / ".env")

LIVE_MODEL = "gemini-3.1-flash-live-preview"

SYSTEM_PROMPT = """You are Sparks — a warm, energetic math tutor for K-12 students in India.

Audience context:
- Students are in Classes 6-10 (ages 11-16), following the NCERT / CBSE / state-board curriculum.
- Many are bilingual (English + Hindi or a regional language). If a student switches to Hindi,
  switch with them — mix Hindi and English naturally ("Chalo, ek example dekhte hain...").
- Use rupees (₹), kilometres, lakhs, local names (Ravi, Priya, Anjali) in word problems.
- Follow the Indian classroom structure: **Given → To Find → Solution → Answer**.

Style:
- Speak conversationally, as if you're sitting beside the student.
- Keep turns SHORT (1–3 sentences) so the student can interrupt and ask questions.
- Be encouraging. Celebrate small wins.
- Ask the student what they understand so far before explaining.

Layout tools (use these FIRST at the start of every problem):

  set_problem(text, latex?, grade?)
    Pin the problem statement in the left panel. `text` is the question in plain
    English/Hindi. `latex` (optional) is a math-only restatement. `grade` (optional)
    is the NCERT class, e.g. "Class 8".

  set_step(current, total, title?)
    Update the step tracker (e.g. 3 of 5). Call before each new step.

  focus(label)
    Elevate an existing card to "current focus" (bright border, others dim).

  set_language(language)
    "en" or "hi". Defaults to "en". Switch when the student switches.

Whiteboard tools (USE DIAGRAMS — students learn best when they see, not just hear):

High-level templates (PREFER these — renderer handles spatial layout so YOU don't have to pick pixel coordinates):

  draw_triangle(sideA, sideB, sideC, rightAngleAt?, vertexLabels?, sideLabels?, label, caption?)
    Triangle from three side lengths (SSS). Optionally mark a right angle at
    vertex "A", "B", or "C". Vertex labels default to A, B, C; side labels
    default to the numeric lengths. Rendered hand-drawn with proper geometry.

  draw_coordinate_plane(xMin, xMax, yMin, yMax, points?, lines?, functions?, label, caption?)
    2D coordinate plane with labeled axes and gridlines.
    - points: [{x, y, label?, color?}]
    - lines: [{from:[x,y], to:[x,y], label?, color?}]
    - functions: [{expression, color?}] — math.js syntax.

  draw_unit_circle(angleDegrees?, showSinCos?, label, caption?)
    Unit circle with axes. If angleDegrees given, draws the angle, the radius,
    and (if showSinCos) its sine/cosine projections with labels.

  draw_parabola(a, b?, c?, showRoots?, showVertex?, xMin?, xMax?, label, caption?)
    Plot y = a·x² + b·x + c. Marks roots (real), vertex, and axis of symmetry
    automatically. Auto-ranges if xMin/xMax not given.

  write_equation(latex, label)
    KaTeX equation, e.g. "2x + 5 = 11" or "\\\\frac{a}{b}".

  plot_function(expression, xMin, xMax, yMin, yMax, label, caption?, annotations?)
    Plot a function. `expression` uses math.js syntax: "x^2 - 3*x + 2", "sin(x)", "sqrt(x)".
    `annotations` = list of {x, text} to label points on the curve.

  draw_number_line(min, max, marks?, highlights?, label, caption?)
    `marks` = list of {value, label?} (ticks with optional text).
    `highlights` = list of {min, max, color?} (shaded intervals for inequalities).

  draw_shapes(shapes, width?, height?, label, caption?)
    `shapes` = list of primitives. Each shape has a `type`:
      {"type":"line",    "x1":.., "y1":.., "x2":.., "y2":.., "color"?}
      {"type":"circle",  "cx":.., "cy":.., "r":..,           "color"?, "filled"?}
      {"type":"polygon", "points":[[x,y],..],                 "color"?, "filled"?}
      {"type":"point",   "x":.., "y":.., "label"?,            "color"?}
      {"type":"text",    "x":.., "y":.., "text":"..",         "color"?, "size"?}
      {"type":"arrow",   "x1":.., "y1":.., "x2":.., "y2":..,  "label"?, "color"?}
    Canvas is SVG pixel space (default 600x400). Origin top-left, y grows DOWN.

  draw_svg(svg, label, caption?)
    Escape hatch — paste raw "<svg ...>...</svg>". Use only when the typed tools
    above don't fit. Keep SVG under 3KB.

  highlight(label): flash any card (equation OR diagram) to focus attention.
  clear_board(): wipe the whiteboard.
  set_topic(title): update the top banner.

Rules:
- At the START of every new problem: call set_problem → set_step(1, N) → then start working.
- ALWAYS prefer the high-level templates (draw_triangle, draw_coordinate_plane,
  draw_unit_circle, draw_parabola, draw_number_line) over draw_shapes or draw_svg.
  They handle spatial layout for you and look polished.
- plot_function works for arbitrary curves; draw_shapes for geometric freeform;
  draw_svg only as a last resort.

**CRITICAL — DO NOT NARRATE WITHOUT DRAWING:**
If you say "let me draw", "I'll show you a diagram", "on the board", "imagine this picture",
or ANY phrase implying a visual, you MUST emit a drawing tool call in the SAME turn.
Saying "I'm drawing" without calling a tool is a failure. The student sees a blank board
and gives up. If no template fits, fall back to draw_shapes. If even that doesn't fit,
fall back to draw_svg with inline SVG markup. Never promise a drawing you don't deliver.

When the student asks about a concept without existing templates (e.g. Newton's laws,
electric circuits, cell biology), use draw_shapes to build the picture from primitives:
lines, arrows, rectangles, circles, text labels. Don't just talk.
- Call the tool BEFORE explaining the visual aloud so the student sees it appear as you speak.
- Use short labels ("eq1", "plot1", "triangle", "answer") so you can highlight them later.
- When the student asks a new question, clear the board first, then set_problem again.
- Keep turns short (1–3 sentences). The student should be able to interrupt.
"""

TOOLS = [{
    "function_declarations": [
        {
            "name": "write_equation",
            "description": "Show a math equation on the whiteboard. Use KaTeX LaTeX syntax.",
            "parameters": {
                "type": "object",
                "properties": {
                    "latex": {"type": "string", "description": "LaTeX equation, e.g. '2x + 5 = 11'"},
                    "label": {"type": "string", "description": "Short identifier for later highlighting"},
                },
                "required": ["latex", "label"],
            },
        },
        {
            "name": "plot_function",
            "description": (
                "Plot a 2D function on a coordinate plane. "
                "expression uses math.js syntax (e.g. 'x^2 - 3*x + 2', 'sin(x)', 'sqrt(x)')."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "expression": {"type": "string"},
                    "xMin": {"type": "number"},
                    "xMax": {"type": "number"},
                    "yMin": {"type": "number"},
                    "yMax": {"type": "number"},
                    "label": {"type": "string"},
                    "caption": {"type": "string"},
                    "annotations": {
                        "type": "array",
                        "description": "Points on the curve to label.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "x": {"type": "number"},
                                "text": {"type": "string"},
                            },
                            "required": ["x", "text"],
                        },
                    },
                },
                "required": ["expression", "xMin", "xMax", "yMin", "yMax", "label"],
            },
        },
        {
            "name": "draw_number_line",
            "description": "Draw a number line with optional tick marks and shaded intervals.",
            "parameters": {
                "type": "object",
                "properties": {
                    "min": {"type": "number"},
                    "max": {"type": "number"},
                    "marks": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "value": {"type": "number"},
                                "label": {"type": "string"},
                            },
                            "required": ["value"],
                        },
                    },
                    "highlights": {
                        "type": "array",
                        "description": "Shaded intervals to show inequalities or ranges.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "min": {"type": "number"},
                                "max": {"type": "number"},
                                "color": {"type": "string"},
                            },
                            "required": ["min", "max"],
                        },
                    },
                    "label": {"type": "string"},
                    "caption": {"type": "string"},
                },
                "required": ["min", "max", "label"],
            },
        },
        {
            "name": "draw_shapes",
            "description": (
                "Draw geometric shapes (lines, circles, polygons, points, text, arrows) "
                "on an SVG canvas. Coordinates are in SVG pixel space (y grows DOWN). "
                "Default canvas is 600x400."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "shapes": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "type": {"type": "string", "description": "line | circle | polygon | point | text | arrow"},
                                "x": {"type": "number"},
                                "y": {"type": "number"},
                                "x1": {"type": "number"},
                                "y1": {"type": "number"},
                                "x2": {"type": "number"},
                                "y2": {"type": "number"},
                                "cx": {"type": "number"},
                                "cy": {"type": "number"},
                                "r": {"type": "number"},
                                "points": {
                                    "type": "array",
                                    "description": "Polygon points; list of [x,y] pairs.",
                                    "items": {
                                        "type": "array",
                                        "items": {"type": "number"},
                                    },
                                },
                                "text": {"type": "string"},
                                "label": {"type": "string"},
                                "color": {"type": "string"},
                                "filled": {"type": "boolean"},
                                "size": {"type": "number"},
                            },
                            "required": ["type"],
                        },
                    },
                    "width": {"type": "number"},
                    "height": {"type": "number"},
                    "label": {"type": "string"},
                    "caption": {"type": "string"},
                },
                "required": ["shapes", "label"],
            },
        },
        {
            "name": "draw_svg",
            "description": (
                "Escape hatch: paste raw SVG markup. Use only when the other drawing "
                "tools don't fit. Keep SVG under 3KB."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "svg": {"type": "string", "description": "Full <svg>...</svg> element."},
                    "label": {"type": "string"},
                    "caption": {"type": "string"},
                },
                "required": ["svg", "label"],
            },
        },
        {
            "name": "draw_triangle",
            "description": (
                "Draw a triangle given three side lengths (SSS). Renderer computes "
                "vertex positions so the triangle is geometrically correct. Optionally "
                "mark a right angle, and label vertices / sides."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "sideA": {"type": "number", "description": "Side opposite vertex A (=BC)"},
                    "sideB": {"type": "number", "description": "Side opposite vertex B (=CA)"},
                    "sideC": {"type": "number", "description": "Side opposite vertex C (=AB)"},
                    "rightAngleAt": {"type": "string", "description": "'A', 'B', or 'C'"},
                    "vertexLabels": {"type": "array", "items": {"type": "string"},
                                      "description": "3 labels [A,B,C]; default ['A','B','C']"},
                    "sideLabels": {"type": "array", "items": {"type": "string"},
                                    "description": "3 labels [a,b,c]; default = numeric lengths"},
                    "label": {"type": "string"},
                    "caption": {"type": "string"},
                },
                "required": ["sideA", "sideB", "sideC", "label"],
            },
        },
        {
            "name": "draw_coordinate_plane",
            "description": (
                "Draw a 2D coordinate plane with labeled axes and gridlines. "
                "Overlay any combination of points, line segments, and function plots."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "xMin": {"type": "number"},
                    "xMax": {"type": "number"},
                    "yMin": {"type": "number"},
                    "yMax": {"type": "number"},
                    "points": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "x": {"type": "number"},
                                "y": {"type": "number"},
                                "label": {"type": "string"},
                                "color": {"type": "string"},
                            },
                            "required": ["x", "y"],
                        },
                    },
                    "lines": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "from": {"type": "array", "items": {"type": "number"}},
                                "to": {"type": "array", "items": {"type": "number"}},
                                "label": {"type": "string"},
                                "color": {"type": "string"},
                            },
                            "required": ["from", "to"],
                        },
                    },
                    "functions": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "expression": {"type": "string"},
                                "color": {"type": "string"},
                            },
                            "required": ["expression"],
                        },
                    },
                    "label": {"type": "string"},
                    "caption": {"type": "string"},
                },
                "required": ["xMin", "xMax", "yMin", "yMax", "label"],
            },
        },
        {
            "name": "draw_unit_circle",
            "description": (
                "Unit circle with coordinate axes. If angleDegrees is supplied, the renderer "
                "draws the angle arc, the radius to (cosθ, sinθ), and (if showSinCos) the "
                "perpendicular sine and cosine projections with numeric values."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "angleDegrees": {"type": "number"},
                    "showSinCos": {"type": "boolean"},
                    "label": {"type": "string"},
                    "caption": {"type": "string"},
                },
                "required": ["label"],
            },
        },
        {
            "name": "draw_parabola",
            "description": (
                "Plot y = a·x² + b·x + c. Automatically marks roots (if real), vertex, "
                "and axis of symmetry. Auto-ranges if xMin/xMax not supplied."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "a": {"type": "number"},
                    "b": {"type": "number"},
                    "c": {"type": "number"},
                    "showRoots": {"type": "boolean"},
                    "showVertex": {"type": "boolean"},
                    "xMin": {"type": "number"},
                    "xMax": {"type": "number"},
                    "label": {"type": "string"},
                    "caption": {"type": "string"},
                },
                "required": ["a", "label"],
            },
        },
        {
            "name": "highlight",
            "description": "Flash any existing card (equation or diagram) to draw attention.",
            "parameters": {
                "type": "object",
                "properties": {"label": {"type": "string"}},
                "required": ["label"],
            },
        },
        {
            "name": "clear_board",
            "description": "Clear the whiteboard of all equations and diagrams.",
            "parameters": {"type": "object", "properties": {}},
        },
        {
            "name": "set_topic",
            "description": "Set the topic banner at the top of the whiteboard.",
            "parameters": {
                "type": "object",
                "properties": {"title": {"type": "string"}},
                "required": ["title"],
            },
        },
        {
            "name": "set_problem",
            "description": "Pin the problem statement in the left panel so the student can always see it.",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "The question in plain English or Hindi."},
                    "latex": {"type": "string", "description": "Optional math-only restatement in LaTeX."},
                    "grade": {"type": "string", "description": "Optional NCERT class, e.g. 'Class 8'."},
                },
                "required": ["text"],
            },
        },
        {
            "name": "set_step",
            "description": "Update the step tracker shown in the header (e.g. 'Step 3 of 5').",
            "parameters": {
                "type": "object",
                "properties": {
                    "current": {"type": "integer"},
                    "total": {"type": "integer"},
                    "title": {"type": "string"},
                },
                "required": ["current", "total"],
            },
        },
        {
            "name": "focus",
            "description": "Elevate a card to 'current focus'. Previous focus dims automatically.",
            "parameters": {
                "type": "object",
                "properties": {"label": {"type": "string"}},
                "required": ["label"],
            },
        },
        {
            "name": "set_language",
            "description": "Change the interface language indicator. 'en' or 'hi'.",
            "parameters": {
                "type": "object",
                "properties": {"language": {"type": "string"}},
                "required": ["language"],
            },
        },
    ]
}]

LIVE_CONFIG = {
    "response_modalities": ["AUDIO"],
    "system_instruction": SYSTEM_PROMPT,
    "tools": TOOLS,
    # Stream STT of the student's mic AND TTS transcript of Sparks' voice.
    "input_audio_transcription": {},
    "output_audio_transcription": {},
    # Push-to-talk: disable auto-VAD and use explicit activity markers so
    # turns don't hang on silence detection.
    "realtime_input_config": {
        "automatic_activity_detection": {"disabled": True},
    },
}


app = FastAPI()


@app.get("/")
async def index():
    return FileResponse(HERE / "static" / "index.html")


@app.get("/architecture")
async def architecture():
    return FileResponse(HERE / "architecture.html")


app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    peer = f"{ws.client.host}:{ws.client.port}" if ws.client else "?"
    log.info("ws-open peer=%s", peer)

    api_key = os.getenv("GEMINI_API_KEY", "")
    if not api_key:
        log.error("GEMINI_API_KEY not set")
        await ws.send_json({"type": "status", "text": "GEMINI_API_KEY not set"})
        await ws.close()
        return

    client = genai.Client(api_key=api_key)

    # Counters so we don't log every single audio chunk (there are hundreds/sec).
    stats = {"mic_chunks": 0, "mic_bytes": 0, "gemini_audio_chunks": 0, "gemini_audio_bytes": 0}

    try:
        log.info("connecting to Gemini Live: model=%s", LIVE_MODEL)
        async with client.aio.live.connect(model=LIVE_MODEL, config=LIVE_CONFIG) as session:
            log.info("gemini live connected")
            await ws.send_json({"type": "status", "text": "Connected. Hold SPACE to talk."})

            async def pump_browser_to_gemini():
                """Read from browser socket, forward to Gemini."""
                try:
                    while True:
                        msg = await ws.receive()
                        if msg["type"] == "websocket.disconnect":
                            log.info("ws-disconnect (from browser)")
                            return
                        if "bytes" in msg and msg["bytes"] is not None:
                            stats["mic_chunks"] += 1
                            stats["mic_bytes"] += len(msg["bytes"])
                            if stats["mic_chunks"] % 25 == 0:
                                log.debug("mic→gemini chunks=%d bytes=%d",
                                          stats["mic_chunks"], stats["mic_bytes"])
                            await session.send_realtime_input(
                                audio=types.Blob(data=msg["bytes"], mime_type="audio/pcm;rate=16000")
                            )
                        elif "text" in msg and msg["text"] is not None:
                            try:
                                data = json.loads(msg["text"])
                            except json.JSONDecodeError:
                                log.warning("bad json from browser: %r", msg["text"][:200])
                                continue
                            t = data.get("type")
                            log.info("browser→server msg: %s", t)
                            if t == "ptt_start":
                                try:
                                    await session.send_realtime_input(
                                        activity_start=types.ActivityStart()
                                    )
                                    log.info("sent activity_start")
                                except Exception:
                                    log.exception("activity_start failed")
                            elif t == "ptt_end":
                                try:
                                    await session.send_realtime_input(
                                        activity_end=types.ActivityEnd()
                                    )
                                    log.info("sent activity_end (mic chunks this turn=%d bytes=%d)",
                                             stats["mic_chunks"], stats["mic_bytes"])
                                except Exception:
                                    log.exception("activity_end failed")
                                stats["mic_chunks"] = 0
                                stats["mic_bytes"] = 0
                            elif t == "tool_result":
                                log.info("browser ack tool id=%s ok=%s",
                                         data.get("id"), data.get("ok"))
                            elif t == "client_log":
                                level = (data.get("level") or "info").lower()
                                msg   = data.get("msg") or ""
                                method = {
                                    "info":  log.info,
                                    "warn":  log.warning,
                                    "error": log.error,
                                }.get(level, log.info)
                                method("[browser] %s", msg[:1500])
                            elif t == "text":
                                # Student typed a message instead of speaking.
                                student_text = (data.get("text") or "").strip()
                                if student_text:
                                    log.info("browser→gemini text: %r", student_text[:120])
                                    try:
                                        await session.send_client_content(
                                            turns=types.Content(
                                                role="user",
                                                parts=[types.Part(text=student_text)],
                                            ),
                                            turn_complete=True,
                                        )
                                    except Exception:
                                        log.exception("send_client_content failed")
                except WebSocketDisconnect:
                    log.info("ws-disconnect raised in browser pump")
                    return
                except Exception:
                    log.exception("browser pump crashed")
                    raise

            async def pump_gemini_to_browser():
                """Read Gemini events, forward audio & tool calls to the browser."""
                try:
                    while True:
                        async for response in session.receive():
                            # Tool calls
                            if getattr(response, "tool_call", None):
                                fn_responses = []
                                for fc in response.tool_call.function_calls:
                                    args = dict(fc.args) if fc.args else {}
                                    log.info("gemini tool_call: name=%s id=%s args=%s",
                                             fc.name, fc.id,
                                             json.dumps(args, default=str)[:500])
                                    try:
                                        await ws.send_json({
                                            "type": "tool_call",
                                            "id": fc.id, "name": fc.name, "args": args,
                                        })
                                    except Exception:
                                        log.exception("failed forwarding tool_call to browser")
                                    fn_responses.append(types.FunctionResponse(
                                        id=fc.id, name=fc.name, response={"result": "ok"},
                                    ))
                                if fn_responses:
                                    await session.send_tool_response(function_responses=fn_responses)

                            # Server content — audio chunks, transcripts, interruptions, turn end
                            sc = getattr(response, "server_content", None)
                            if sc:
                                if getattr(sc, "interrupted", False):
                                    log.info("gemini interrupt")
                                    await ws.send_json({"type": "interrupt"})

                                # Input transcription (student's STT)
                                it = getattr(sc, "input_transcription", None)
                                if it is not None:
                                    txt = getattr(it, "text", None) or ""
                                    if txt:
                                        log.debug("stt user: %r", txt[:120])
                                        await ws.send_json({
                                            "type": "transcript",
                                            "role": "user",
                                            "text": txt,
                                            "final": bool(getattr(it, "finished", False)),
                                        })

                                # Output transcription (Sparks' TTS transcript)
                                ot = getattr(sc, "output_transcription", None)
                                if ot is not None:
                                    txt = getattr(ot, "text", None) or ""
                                    if txt:
                                        log.debug("tts sparks: %r", txt[:120])
                                        await ws.send_json({
                                            "type": "transcript",
                                            "role": "assistant",
                                            "text": txt,
                                            "final": bool(getattr(ot, "finished", False)),
                                        })

                                mt = getattr(sc, "model_turn", None)
                                if mt and mt.parts:
                                    for part in mt.parts:
                                        # Log any text content (sometimes emitted as transcript)
                                        text = getattr(part, "text", None)
                                        if text:
                                            log.debug("gemini text part: %r", text[:120])
                                        # Some SDK versions expose function calls here too
                                        fc = getattr(part, "function_call", None)
                                        if fc:
                                            log.info("gemini inline function_call: name=%s args=%s",
                                                     fc.name, dict(fc.args or {}))
                                        inline = getattr(part, "inline_data", None)
                                        if inline and inline.data:
                                            stats["gemini_audio_chunks"] += 1
                                            stats["gemini_audio_bytes"] += len(inline.data)
                                            if stats["gemini_audio_chunks"] % 20 == 0:
                                                log.debug("gemini→browser audio chunks=%d bytes=%d",
                                                          stats["gemini_audio_chunks"],
                                                          stats["gemini_audio_bytes"])
                                            await ws.send_bytes(inline.data)
                                if getattr(sc, "turn_complete", False):
                                    log.info("gemini turn_complete (audio chunks=%d bytes=%d)",
                                             stats["gemini_audio_chunks"],
                                             stats["gemini_audio_bytes"])
                                    stats["gemini_audio_chunks"] = 0
                                    stats["gemini_audio_bytes"] = 0
                                    await ws.send_json({"type": "turn_complete"})
                except Exception:
                    log.exception("gemini pump crashed")
                    raise

            await asyncio.gather(pump_browser_to_gemini(), pump_gemini_to_browser())

    except WebSocketDisconnect:
        log.info("ws-disconnect (outer)")
    except Exception as e:
        tb = traceback.format_exc()
        log.error("session error: %s\n%s", e, tb)
        try:
            await ws.send_json({"type": "status", "text": f"Error: {e}"})
        except Exception:
            pass
    finally:
        try:
            await ws.close()
        except Exception:
            pass
        log.info("ws-close peer=%s", peer)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="127.0.0.1", port=8765, reload=False)
