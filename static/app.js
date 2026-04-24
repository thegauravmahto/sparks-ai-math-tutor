// Main client: WebSocket bridge, mic capture (push-to-talk via SPACE), playback, tool dispatch.
(() => {
  const statusEl = document.getElementById("status");
  const topicEl = document.getElementById("topic");
  const board = document.getElementById("board");
  const bubble = document.getElementById("speech-bubble");
  const pttBtn = document.getElementById("pttBtn");

  const equationMap = new Map(); // label -> DOM node

  // ---------- Status helpers ----------
  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.classList.remove("live", "listening", "error");
    if (cls) statusEl.classList.add(cls);
  }

  // ---------- WebSocket ----------
  const wsURL = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws";
  const ws = new WebSocket(wsURL);
  ws.binaryType = "arraybuffer";

  ws.addEventListener("open", () => setStatus("connected", "live"));
  ws.addEventListener("close", () => setStatus("disconnected", "error"));
  ws.addEventListener("error", () => setStatus("socket error", "error"));
  ws.addEventListener("message", (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      enqueuePCM(ev.data);
    } else {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      handleServerMessage(msg);
    }
  });

  function sendJSON(obj) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }
  function sendBytes(buf) {
    if (ws.readyState === WebSocket.OPEN) ws.send(buf);
  }

  // ---------- Server control messages ----------
  function handleServerMessage(msg) {
    switch (msg.type) {
      case "status": setStatus(msg.text, "live"); break;
      case "tool_call": dispatchTool(msg.id, msg.name, msg.args || {}); break;
      case "interrupt":
        flushPlayback();
        setAvatarTalking(false);
        setMouthAmplitude(0);
        break;
      case "turn_complete":
        setAvatarTalking(false);
        break;
    }
  }

  // ---------- Tool dispatch ----------
  function dispatchTool(id, name, args) {
    try {
      if (name === "write_equation") writeEquation(args.latex, args.label);
      else if (name === "highlight") highlightLabel(args.label);
      else if (name === "clear_board") clearBoard();
      else if (name === "set_topic") topicEl.textContent = args.title || "";
      sendJSON({ type: "tool_result", id, ok: true });
    } catch (e) {
      console.error(e);
      sendJSON({ type: "tool_result", id, ok: false, error: String(e) });
    }
  }

  function writeEquation(latex, label) {
    if (!latex) return;
    const card = document.createElement("div");
    card.className = "eq-card";
    try {
      katex.render(latex, card, { throwOnError: false, displayMode: true });
    } catch {
      card.textContent = latex;
    }
    if (label) {
      const prev = equationMap.get(label);
      if (prev) prev.remove();
      equationMap.set(label, card);
    }
    board.appendChild(card);
    board.scrollTop = board.scrollHeight;
  }
  function highlightLabel(label) {
    const node = equationMap.get(label);
    if (!node) return;
    node.classList.add("flash");
    setTimeout(() => node.classList.remove("flash"), 1600);
  }
  function clearBoard() {
    board.innerHTML = "";
    equationMap.clear();
  }

  // ============== Audio playback (24 kHz PCM) ==============
  let outCtx = null;
  let playCursor = 0;   // absolute time when next chunk should play
  let playingCount = 0;
  const OUT_RATE = 24000;

  function ensureOutCtx() {
    if (!outCtx) {
      outCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: OUT_RATE });
    }
    return outCtx;
  }

  function enqueuePCM(arrayBuffer) {
    const ctx = ensureOutCtx();
    const pcm = new Int16Array(arrayBuffer);
    if (pcm.length === 0) return;
    const buf = ctx.createBuffer(1, pcm.length, OUT_RATE);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;

    // Analyser chain for mouth amplitude
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    analyser.connect(ctx.destination);

    const now = ctx.currentTime;
    const startAt = Math.max(now, playCursor);
    src.start(startAt);
    playCursor = startAt + buf.duration;
    playingCount++;
    setAvatarTalking(true);

    const timeData = new Uint8Array(analyser.fftSize);
    function tick() {
      if (ctx.currentTime < startAt) { requestAnimationFrame(tick); return; }
      analyser.getByteTimeDomainData(timeData);
      let sum = 0;
      for (let i = 0; i < timeData.length; i++) {
        const v = (timeData[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / timeData.length);
      setMouthAmplitude(Math.min(1, rms * 4));
      if (ctx.currentTime < startAt + buf.duration) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);

    src.onended = () => {
      playingCount--;
      if (playingCount <= 0) {
        setMouthAmplitude(0);
        setAvatarTalking(false);
      }
    };
  }

  function flushPlayback() {
    if (!outCtx) return;
    // Recreate context to instantly kill queued audio on interrupt.
    try { outCtx.close(); } catch {}
    outCtx = null;
    playCursor = 0;
    playingCount = 0;
  }

  // ============== Mic capture (16 kHz PCM, push-to-talk) ==============
  let inCtx = null;
  let micStream = null;
  let workletNode = null;
  let micSource = null;
  let capturing = false;

  async function initMic() {
    if (inCtx) return;
    inCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    await inCtx.audioWorklet.addModule("/static/pcm-worklet.js");
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, sampleRate: 16000 },
    });
    micSource = inCtx.createMediaStreamSource(micStream);
    workletNode = new AudioWorkletNode(inCtx, "pcm-capture");
    workletNode.port.onmessage = (ev) => {
      if (!capturing) return;
      sendBytes(ev.data);
    };
    micSource.connect(workletNode);
    // Do not connect to destination — we don't want to hear ourselves.
  }

  async function startTalking() {
    if (capturing) return;
    try {
      await initMic();
      if (inCtx.state === "suspended") await inCtx.resume();
      capturing = true;
      pttBtn.classList.add("talking");
      setStatus("listening…", "listening");
    } catch (e) {
      setStatus("mic error: " + e.message, "error");
    }
  }
  function stopTalking() {
    if (!capturing) return;
    capturing = false;
    pttBtn.classList.remove("talking");
    setStatus("thinking…", "live");
    sendJSON({ type: "ptt_end" });
  }

  // Spacebar push-to-talk
  window.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || e.repeat) return;
    if (document.activeElement && ["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
    e.preventDefault();
    startTalking();
  });
  window.addEventListener("keyup", (e) => {
    if (e.code !== "Space") return;
    e.preventDefault();
    stopTalking();
  });

  // Mouse/touch push-to-talk
  pttBtn.addEventListener("mousedown", startTalking);
  pttBtn.addEventListener("touchstart", (e) => { e.preventDefault(); startTalking(); });
  window.addEventListener("mouseup", stopTalking);
  window.addEventListener("touchend", stopTalking);

  // First click unlocks audio output context on strict browsers.
  window.addEventListener("click", () => { ensureOutCtx(); }, { once: true });
})();
