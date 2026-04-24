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
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from google import genai
from google.genai import types

HERE = Path(__file__).parent
# Load .env from livetutor/ first, then fall back to parent dir for monorepo use.
load_dotenv(HERE / ".env")
load_dotenv(HERE.parent / ".env")

LIVE_MODEL = "gemini-3.1-flash-live-preview"

SYSTEM_PROMPT = """You are Sparks — a warm, energetic math tutor for middle-school students.

Style:
- Speak conversationally, as if you're sitting beside the student.
- Keep turns SHORT (1–3 sentences) so the student can interrupt and ask questions.
- Be encouraging. Celebrate small wins.
- Ask the student what they understand so far before explaining.

Whiteboard tools (USE THEM — do not just narrate math):
- write_equation(latex, label): show an equation on the board (KaTeX LaTeX, e.g. "2x + 5 = 11").
- highlight(label): flash an existing labelled equation to draw attention.
- clear_board(): wipe the whiteboard before starting a new problem.
- set_topic(title): set the topic label at the top of the board.

Rules:
- Call write_equation BEFORE explaining a step aloud, so the student sees the math as you speak.
- Use short labels ("eq1", "step2", "answer") so you can highlight them later.
- When the student asks a new question, clear the board first.
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
            "name": "highlight",
            "description": "Flash an existing equation on the board to draw attention.",
            "parameters": {
                "type": "object",
                "properties": {"label": {"type": "string"}},
                "required": ["label"],
            },
        },
        {
            "name": "clear_board",
            "description": "Clear the whiteboard of all equations.",
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
    ]
}]

LIVE_CONFIG = {
    "response_modalities": ["AUDIO"],
    "system_instruction": SYSTEM_PROMPT,
    "tools": TOOLS,
}


app = FastAPI()


@app.get("/")
async def index():
    return FileResponse(HERE / "static" / "index.html")


app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()

    api_key = os.getenv("GEMINI_API_KEY", "")
    if not api_key:
        await ws.send_json({"type": "status", "text": "GEMINI_API_KEY not set"})
        await ws.close()
        return

    client = genai.Client(api_key=api_key)

    try:
        async with client.aio.live.connect(model=LIVE_MODEL, config=LIVE_CONFIG) as session:
            await ws.send_json({"type": "status", "text": "Connected. Hold SPACE to talk."})

            async def pump_browser_to_gemini():
                """Read from browser socket, forward to Gemini."""
                try:
                    while True:
                        msg = await ws.receive()
                        if msg["type"] == "websocket.disconnect":
                            return
                        if "bytes" in msg and msg["bytes"] is not None:
                            # Mic PCM → Gemini
                            await session.send_realtime_input(
                                audio=types.Blob(data=msg["bytes"], mime_type="audio/pcm;rate=16000")
                            )
                        elif "text" in msg and msg["text"] is not None:
                            try:
                                data = json.loads(msg["text"])
                            except json.JSONDecodeError:
                                continue
                            t = data.get("type")
                            if t == "ptt_end":
                                # Tell Gemini: user stopped talking → respond now
                                try:
                                    await session.send_realtime_input(audio_stream_end=True)
                                except Exception:
                                    pass
                            # tool_result handling: browser acknowledges a tool call.
                            # We already sent an optimistic FunctionResponse to Gemini,
                            # so nothing more needs to happen here.
                except WebSocketDisconnect:
                    return

            async def pump_gemini_to_browser():
                """Read Gemini events, forward audio & tool calls to the browser."""
                while True:
                    async for response in session.receive():
                        # Tool calls
                        if getattr(response, "tool_call", None):
                            fn_responses = []
                            for fc in response.tool_call.function_calls:
                                args = dict(fc.args) if fc.args else {}
                                await ws.send_json({
                                    "type": "tool_call",
                                    "id": fc.id,
                                    "name": fc.name,
                                    "args": args,
                                })
                                fn_responses.append(types.FunctionResponse(
                                    id=fc.id, name=fc.name, response={"result": "ok"},
                                ))
                            if fn_responses:
                                await session.send_tool_response(function_responses=fn_responses)

                        # Server content — audio chunks, interruptions, turn end
                        sc = getattr(response, "server_content", None)
                        if sc:
                            if getattr(sc, "interrupted", False):
                                await ws.send_json({"type": "interrupt"})
                            mt = getattr(sc, "model_turn", None)
                            if mt and mt.parts:
                                for part in mt.parts:
                                    inline = getattr(part, "inline_data", None)
                                    if inline and inline.data:
                                        await ws.send_bytes(inline.data)
                            if getattr(sc, "turn_complete", False):
                                await ws.send_json({"type": "turn_complete"})

            await asyncio.gather(pump_browser_to_gemini(), pump_gemini_to_browser())

    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await ws.send_json({"type": "status", "text": f"Error: {e}"})
        except Exception:
            pass
        print(f"WS error: {e}", file=sys.stderr)
    finally:
        try:
            await ws.close()
        except Exception:
            pass


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="127.0.0.1", port=8765, reload=False)
