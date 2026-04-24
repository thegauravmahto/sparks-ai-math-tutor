# Livetutor — Sparks the Live Math Tutor

A realtime voice-to-voice math tutor. The student holds **SPACE**, asks a
question, releases, and a cartoon doodle named Sparks answers out loud while
writing equations on a whiteboard.

No pre-rendered videos. No STT/TTS pipeline. The browser streams raw mic PCM
to the server, which bridges the stream to the **Gemini Live API** (native
audio in → native audio out). Gemini also calls tools that render KaTeX
equations on the page as it speaks.

## Stack

- **Gemini Live API** — `gemini-3.1-flash-live-preview`, native voice I/O +
  tool calling
- **FastAPI + WebSocket** — Python bridge between the browser and Gemini
- **AudioWorklet** — Float32 mic samples → 16 kHz / 16-bit PCM
- **Web Audio API** — contiguous playback of the 24 kHz PCM stream from Gemini
- **SVG avatar** — mouth scaled by live audio RMS, blinking, mouse eye-tracking
- **KaTeX** — tool-call-driven equation rendering on the whiteboard

## Run locally

```bash
pip install -r requirements.txt
cp .env.example .env   # then paste your GEMINI_API_KEY
python server.py
# open http://127.0.0.1:8765 in Chrome or Safari
```

Hold **SPACE** (or the orange button) to talk. Release to send.

## Tools the model can call

| Tool | Purpose |
|------|---------|
| `write_equation(latex, label)` | Adds a KaTeX card to the board |
| `highlight(label)` | Flashes an existing card |
| `clear_board()` | Wipes the board |
| `set_topic(title)` | Updates the top banner |

## Layout

```
livetutor/
├── server.py            # FastAPI bridge: browser WS ↔ Gemini Live
├── requirements.txt
└── static/
    ├── index.html       # whiteboard + avatar shell
    ├── style.css
    ├── app.js           # mic capture, playback, tool dispatch, PTT
    ├── avatar.js        # SVG doodle animation
    └── pcm-worklet.js   # Float32 → Int16 16 kHz PCM encoder
```
