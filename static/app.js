// Main client: WebSocket bridge, mic capture (push-to-talk via SPACE), playback,
// tool dispatch (equations + diagrams), transcript panel, text input.
(() => {
  const statusEl    = document.getElementById("status");
  const topicEl     = document.getElementById("topic");
  const gradeEl     = document.getElementById("grade");
  const stepEl      = document.getElementById("step");
  const board       = document.getElementById("board");
  const pttBtn      = document.getElementById("pttBtn");
  const langBtn     = document.getElementById("langBtn");
  const problemPanelEmpty = document.getElementById("problem-empty");
  const problemTextEl     = document.getElementById("problem-text");
  const problemLatexEl    = document.getElementById("problem-latex");
  const transcriptEl = document.getElementById("transcript");
  const textForm    = document.getElementById("text-form");
  const textInput   = document.getElementById("text-input");

  const SVG_NS = "http://www.w3.org/2000/svg";
  const cardMap = new Map();     // label -> DOM card node
  let focusedLabel = null;
  let plotCounter = 0;

  // ---------- Logging (also relays to server WS so it shows in the Python terminal) ----------
  let ws = null;   // will be set right below; log helpers access it lazily
  const LOG_STYLE = "color:#7ee8a6;font-weight:600";
  function _fmt(args) {
    return args.map(a => {
      if (typeof a === "string") return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(" ");
  }
  function _relay(level, args) {
    try {
      if (ws && ws.readyState === 1 /* OPEN */) {
        ws.send(JSON.stringify({ type: "client_log", level, msg: _fmt(args).slice(0, 1500) }));
      }
    } catch {}
  }
  const logInfo  = (...a) => { console.log  ("%c[livetutor]", LOG_STYLE, ...a); _relay("info",  a); };
  const logWarn  = (...a) => { console.warn ("%c[livetutor]", LOG_STYLE, ...a); _relay("warn",  a); };
  const logError = (...a) => { console.error("%c[livetutor]", LOG_STYLE, ...a); _relay("error", a); };
  window.livetutor = {
    cardMap,
    dumpCards: () => [...cardMap.entries()].map(([k, v]) => ({ label: k, class: v.className })),
  };

  // ---------- Status ----------
  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.classList.remove("live", "listening", "error");
    if (cls) statusEl.classList.add(cls);
  }

  // ---------- WebSocket ----------
  const wsURL = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws";
  ws = new WebSocket(wsURL);
  ws.binaryType = "arraybuffer";

  ws.addEventListener("open",  () => { logInfo("ws open"); setStatus("connected", "live"); });
  ws.addEventListener("close", (e) => { logInfo("ws close", e.code, e.reason); setStatus("disconnected", "error"); });
  ws.addEventListener("error", (e) => { logError("ws error", e); setStatus("socket error", "error"); });
  ws.addEventListener("message", (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      enqueuePCM(ev.data);
    } else {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type !== "transcript") {
        logInfo("server→client", msg.type, msg.name ? `(${msg.name})` : "", msg.args || msg.text || "");
      }
      handleServerMessage(msg);
    }
  });

  const sendJSON  = (obj) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(obj));
  const sendBytes = (buf) => ws.readyState === WebSocket.OPEN && ws.send(buf);

  function handleServerMessage(msg) {
    switch (msg.type) {
      case "status":         setStatus(msg.text, "live"); break;
      case "tool_call":      dispatchTool(msg.id, msg.name, msg.args || {}); break;
      case "transcript":     handleTranscript(msg.role, msg.text, msg.final); break;
      case "interrupt":      flushPlayback(); setAvatarTalking(false); setMouthAmplitude(0); closeOpenBubbles(); break;
      case "turn_complete":  setAvatarTalking(false); closeOpenBubbles(); break;
    }
  }

  // ==============================================================
  //   Transcript panel
  // ==============================================================
  const openBubble = { user: null, assistant: null };

  function handleTranscript(role, text, final) {
    if (!text) return;
    let bubble = openBubble[role];
    if (!bubble) {
      bubble = createBubble(role);
      openBubble[role] = bubble;
    }
    // Gemini streams partial transcripts as cumulative chunks; concat them.
    const textSpan = bubble.querySelector(".text");
    textSpan.textContent = (textSpan.textContent || "") + text;
    bubble.classList.toggle("partial", !final);
    if (final) openBubble[role] = null;
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }

  function createBubble(role) {
    const b = document.createElement("div");
    b.className = `bubble ${role} partial`;
    const r = document.createElement("span");
    r.className = "role";
    r.textContent = role === "user" ? "You" : "Sparks";
    const t = document.createElement("span");
    t.className = "text";
    b.appendChild(r);
    b.appendChild(t);
    transcriptEl.appendChild(b);
    return b;
  }

  function closeOpenBubbles() {
    for (const k of Object.keys(openBubble)) {
      const b = openBubble[k];
      if (b) b.classList.remove("partial");
      openBubble[k] = null;
    }
  }

  function addLocalBubble(role, text) {
    // For text the student typed: we already know the final text; just drop it in.
    const bubble = createBubble(role);
    bubble.querySelector(".text").textContent = text;
    bubble.classList.remove("partial");
    openBubble[role] = null;
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }

  // ==============================================================
  //   Tool dispatch
  // ==============================================================
  function dispatchTool(id, name, args) {
    logInfo("tool →", name, args);
    try {
      switch (name) {
        case "write_equation":        writeEquation(args.latex, args.label); break;
        case "plot_function":         plotFunction(args); break;
        case "draw_number_line":      drawNumberLine(args); break;
        case "draw_triangle":         drawTriangle(args); break;
        case "draw_coordinate_plane": drawCoordinatePlane(args); break;
        case "draw_unit_circle":      drawUnitCircle(args); break;
        case "draw_parabola":         drawParabola(args); break;
        case "draw_shapes":           drawShapes(args); break;
        case "draw_svg":              drawRawSvg(args); break;
        case "highlight":             highlightLabel(args.label); break;
        case "clear_board":       clearBoard(); break;
        case "set_topic":         topicEl.textContent = args.title || "Sparks"; break;
        case "set_problem":       setProblem(args); break;
        case "set_step":          setStep(args); break;
        case "focus":             focusLabel(args.label); break;
        case "set_language":      setLanguage(args.language); break;
        default: logWarn("unknown tool:", name, args);
      }
      sendJSON({ type: "tool_result", id, ok: true });
    } catch (e) {
      logError("tool error", name, e, args);
      sendJSON({ type: "tool_result", id, ok: false, error: String(e) });
    }
  }

  // ---------- Problem / step / focus / language ----------
  function setProblem({ text, latex, grade }) {
    if (grade) gradeEl.textContent = grade;
    problemPanelEmpty.classList.add("hidden");
    if (text) {
      problemTextEl.textContent = text;
      problemTextEl.classList.remove("hidden");
    }
    if (latex) {
      problemLatexEl.innerHTML = "";
      try { katex.render(latex, problemLatexEl, { throwOnError: false, displayMode: true }); }
      catch { problemLatexEl.textContent = latex; }
      problemLatexEl.classList.remove("hidden");
    } else {
      problemLatexEl.classList.add("hidden");
    }
  }
  function setStep({ current, total, title }) {
    stepEl.textContent = title ? `Step ${current}/${total} · ${title}` : `Step ${current}/${total}`;
  }
  function focusLabel(label) {
    const node = cardMap.get(label);
    if (!node) return;
    if (focusedLabel && cardMap.get(focusedLabel)) {
      cardMap.get(focusedLabel).classList.remove("focused");
      cardMap.get(focusedLabel).classList.add("dimmed");
    }
    node.classList.remove("dimmed");
    node.classList.add("focused");
    focusedLabel = label;
    node.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  function setLanguage(lang) {
    const l = (lang || "en").toLowerCase();
    langBtn.textContent = l === "hi" ? "हिं" : "EN";
  }

  // ---------- Card helpers ----------
  function registerCard(label, card) {
    if (!label) return;
    const prev = cardMap.get(label);
    if (prev) prev.remove();
    cardMap.set(label, card);
  }
  function appendCard(card) {
    board.appendChild(card);
    requestAnimationFrame(() => {
      board.scrollTop = board.scrollHeight;
      const r = card.getBoundingClientRect();
      logInfo("card appended", card.className,
        `w=${Math.round(r.width)} h=${Math.round(r.height)} ` +
        `boardChildren=${board.children.length}`);
    });
  }
  function makeDiagramCard(caption) {
    const card = document.createElement("div");
    card.className = "diagram-card";
    if (caption) {
      const cap = document.createElement("div");
      cap.className = "caption";
      cap.textContent = caption;
      card.appendChild(cap);
    }
    return card;
  }

  // ---------- Equation ----------
  function writeEquation(latex, label) {
    if (!latex) return;
    const card = document.createElement("div");
    card.className = "eq-card";
    try { katex.render(latex, card, { throwOnError: false, displayMode: true }); }
    catch { card.textContent = latex; }
    registerCard(label, card);
    appendCard(card);
  }

  // ---------- Function plot ----------
  function plotFunction(args) {
    const { expression, xMin, xMax, yMin, yMax, label, caption, annotations = [] } = args;
    const card = makeDiagramCard(caption);
    const host = document.createElement("div");
    host.className = "plot-host";
    const targetId = "plot_" + (++plotCounter);
    host.id = targetId;
    card.appendChild(host);
    registerCard(label, card);
    appendCard(card);

    if (typeof window.functionPlot !== "function") {
      const err = document.createElement("div");
      err.style.color = "#b00020";
      err.textContent = "function-plot.js not loaded — check network / CDN";
      host.appendChild(err);
      logError("window.functionPlot missing — did the CDN script load?");
      return;
    }
    try {
      window.functionPlot({
        target: "#" + targetId,
        width: 640, height: 400,
        grid: true,
        yAxis: { domain: [yMin, yMax] },
        xAxis: { domain: [xMin, xMax] },
        data: [
          { fn: expression, color: "#ff5470", graphType: "polyline" },
          ...(annotations.length ? [{
            points: annotations.map(a => [a.x, safeEval(expression, a.x)]),
            fnType: "points", graphType: "scatter", color: "#1e88e5",
          }] : []),
        ],
        annotations: annotations.map(a => ({ x: a.x, text: a.text })),
      });
    } catch (e) {
      const err = document.createElement("div");
      err.style.color = "#b00020";
      err.textContent = "plot error: " + e.message;
      host.appendChild(err);
    }
  }
  function safeEval(expr, x) {
    try {
      const f = new Function("x", `with (Math) { return (${expr.replace(/\^/g, "**")}); }`);
      return f(x);
    } catch { return 0; }
  }

  // ---------- Number line ----------
  function drawNumberLine(args) {
    const { min, max, marks = [], highlights = [], label, caption } = args;
    const card = makeDiagramCard(caption);
    const host = document.createElement("div");
    host.className = "number-line-host";
    card.appendChild(host);

    const W = 840, H = 140, pad = 40;
    const span = max - min || 1;
    const toX = (v) => pad + ((v - min) / span) * (W - 2 * pad);

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("width", String(W));
    svg.setAttribute("height", String(H));
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.style.width = "100%";
    svg.style.height = "auto";
    host.appendChild(svg);
    const rc = window.rough.svg(svg);

    for (const h of highlights) {
      const x1 = toX(Math.max(min, h.min));
      const x2 = toX(Math.min(max, h.max));
      svg.appendChild(rc.rectangle(
        Math.min(x1, x2), H / 2 - 16, Math.abs(x2 - x1), 32,
        { fill: h.color || "#ffd166", fillStyle: "hachure", fillWeight: 1.4,
          hachureAngle: 40, hachureGap: 6, stroke: "none" },
      ));
    }
    svg.appendChild(rc.line(pad, H / 2, W - pad, H / 2,
      { stroke: "#222", strokeWidth: 2.5, roughness: 1.2 }));
    svg.appendChild(rc.line(W - pad - 12, H / 2 - 10, W - pad, H / 2,
      { stroke: "#222", strokeWidth: 2, roughness: 1.2 }));
    svg.appendChild(rc.line(W - pad - 12, H / 2 + 10, W - pad, H / 2,
      { stroke: "#222", strokeWidth: 2, roughness: 1.2 }));

    for (const m of marks) {
      const x = toX(m.value);
      svg.appendChild(rc.line(x, H / 2 - 10, x, H / 2 + 10,
        { stroke: "#222", strokeWidth: 2, roughness: 1 }));
      const t = document.createElementNS(SVG_NS, "text");
      t.setAttribute("x", x); t.setAttribute("y", H / 2 + 34);
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("font-family", "ui-rounded, 'SF Pro Rounded', sans-serif");
      t.setAttribute("font-size", "18"); t.setAttribute("fill", "#1a1a1a");
      t.textContent = m.label || String(m.value);
      svg.appendChild(t);
    }

    registerCard(label, card);
    appendCard(card);
  }

  // ==============================================================
  //   HIGH-LEVEL DIAGRAM TEMPLATES
  // ==============================================================

  // ---------- Triangle (SSS) ----------
  function drawTriangle(args) {
    const {
      sideA, sideB, sideC,
      rightAngleAt, vertexLabels = ["A", "B", "C"], sideLabels,
      label, caption,
    } = args;

    // Validate triangle inequality
    if (sideA + sideB <= sideC || sideB + sideC <= sideA || sideA + sideC <= sideB) {
      logWarn("invalid triangle sides", args);
      return;
    }

    // Math-space vertex positions
    const Bx = 0, By = 0;
    const Cx = sideA, Cy = 0;
    const Ax = (sideC*sideC - sideB*sideB + sideA*sideA) / (2 * sideA);
    const Ay = Math.sqrt(Math.max(0, sideC*sideC - Ax*Ax));

    // Fit to SVG canvas with padding
    const W = 620, H = 440, padding = 70;
    const minX = Math.min(0, Ax), maxX = Math.max(sideA, Ax);
    const minY = 0, maxY = Ay;
    const scale = Math.min((W - 2*padding) / (maxX - minX), (H - 2*padding) / Math.max(maxY - minY, 1));
    const offX = (W - (maxX + minX) * scale) / 2;
    const offY = H - padding;
    const toPx = (x, y) => [offX + x * scale, offY - (y - minY) * scale];

    const [bx, by] = toPx(Bx, By);
    const [cx2, cy2] = toPx(Cx, Cy);
    const [ax, ay] = toPx(Ax, Ay);

    const card = makeDiagramCard(caption);
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("width", String(W));
    svg.setAttribute("height", String(H));
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.style.background = "#fafbff";
    svg.style.borderRadius = "10px";
    svg.style.width = "100%";
    svg.style.height = "auto";
    card.appendChild(svg);
    const rc = window.rough.svg(svg);

    // Triangle
    svg.appendChild(rc.polygon([[bx, by], [cx2, cy2], [ax, ay]],
      { stroke: "#1e88e5", strokeWidth: 2.6, roughness: 1.1 }));

    // Right-angle mark
    if (rightAngleAt) {
      let C0, P1, P2;
      if (rightAngleAt === "A")      { C0 = [ax, ay];  P1 = [bx, by];  P2 = [cx2, cy2]; }
      else if (rightAngleAt === "B") { C0 = [bx, by];  P1 = [ax, ay];  P2 = [cx2, cy2]; }
      else                           { C0 = [cx2, cy2]; P1 = [bx, by];  P2 = [ax, ay]; }
      const s = 14;
      const d1x = P1[0] - C0[0], d1y = P1[1] - C0[1];
      const d2x = P2[0] - C0[0], d2y = P2[1] - C0[1];
      const m1 = Math.hypot(d1x, d1y), m2 = Math.hypot(d2x, d2y);
      const u1 = [d1x / m1 * s, d1y / m1 * s];
      const u2 = [d2x / m2 * s, d2y / m2 * s];
      svg.appendChild(rc.polygon([
        C0,
        [C0[0] + u1[0], C0[1] + u1[1]],
        [C0[0] + u1[0] + u2[0], C0[1] + u1[1] + u2[1]],
        [C0[0] + u2[0], C0[1] + u2[1]],
      ], { stroke: "#1e88e5", strokeWidth: 1.4, roughness: 0.3 }));
    }

    // Vertex labels (nudged away from the triangle)
    addText(svg, ax, ay - 14, vertexLabels[0] || "A", "#1e88e5", 22);
    addText(svg, bx - 18, by + 22, vertexLabels[1] || "B", "#1e88e5", 22);
    addText(svg, cx2 + 10, cy2 + 22, vertexLabels[2] || "C", "#1e88e5", 22);

    // Side labels
    const labels = sideLabels && sideLabels.length >= 3
      ? sideLabels
      : [String(sideA), String(sideB), String(sideC)];
    addText(svg, (bx + cx2) / 2, (by + cy2) / 2 + 24, labels[0], "#444", 18);   // a = BC
    addText(svg, (cx2 + ax) / 2 + 14, (cy2 + ay) / 2 + 4, labels[1], "#444", 18); // b = CA
    addText(svg, (ax + bx) / 2 - 22, (ay + by) / 2 + 4, labels[2], "#444", 18); // c = AB

    registerCard(label, card);
    appendCard(card);
  }

  // ---------- Coordinate plane ----------
  function drawCoordinatePlane(args) {
    const { xMin, xMax, yMin, yMax, points = [], lines = [], functions = [],
            label, caption } = args;

    // If functions specified, delegate to function-plot for axis/curve rendering
    if (functions.length > 0 && typeof window.functionPlot === "function") {
      const card = makeDiagramCard(caption);
      const host = document.createElement("div");
      host.className = "plot-host";
      const id = "cplane_" + (++plotCounter);
      host.id = id;
      card.appendChild(host);
      registerCard(label, card);
      appendCard(card);

      const data = functions.map(f => ({
        fn: f.expression, color: f.color || "#ff5470", graphType: "polyline",
      }));
      if (points.length) {
        data.push({
          points: points.map(p => [p.x, p.y]),
          fnType: "points", graphType: "scatter", color: "#1e88e5",
        });
      }
      for (const ln of lines) {
        data.push({
          points: [ln.from, ln.to],
          fnType: "points", graphType: "polyline",
          color: ln.color || "#2ca95a",
        });
      }
      try {
        window.functionPlot({
          target: "#" + id, width: 640, height: 400, grid: true,
          yAxis: { domain: [yMin, yMax] }, xAxis: { domain: [xMin, xMax] }, data,
        });
      } catch (e) { logError("coordinate_plane plot error", e); }
      return;
    }

    // Custom Rough.js rendering for points + lines only
    const W = 620, H = 420, padding = 50;
    const sx = (W - 2*padding) / (xMax - xMin);
    const sy = (H - 2*padding) / (yMax - yMin);
    const toPx = (x, y) => [padding + (x - xMin) * sx, H - padding - (y - yMin) * sy];

    const card = makeDiagramCard(caption);
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("width", String(W));
    svg.setAttribute("height", String(H));
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.style.background = "#fafbff";
    svg.style.borderRadius = "10px";
    svg.style.width = "100%";
    svg.style.height = "auto";
    card.appendChild(svg);
    const rc = window.rough.svg(svg);

    // Gridlines (unit spacing)
    for (let x = Math.ceil(xMin); x <= Math.floor(xMax); x++) {
      const [px] = toPx(x, 0);
      svg.appendChild(rc.line(px, padding, px, H - padding,
        { stroke: "#e4e8f2", strokeWidth: 1, roughness: 0.2 }));
    }
    for (let y = Math.ceil(yMin); y <= Math.floor(yMax); y++) {
      const [, py] = toPx(0, y);
      svg.appendChild(rc.line(padding, py, W - padding, py,
        { stroke: "#e4e8f2", strokeWidth: 1, roughness: 0.2 }));
    }

    // Main axes (if origin visible)
    const originInView = xMin <= 0 && xMax >= 0 && yMin <= 0 && yMax >= 0;
    const [ox, oy] = originInView ? toPx(0, 0) : [padding, H - padding];
    if (xMin <= 0 && xMax >= 0) {
      svg.appendChild(rc.line(ox, padding, ox, H - padding,
        { stroke: "#222", strokeWidth: 1.8, roughness: 0.4 }));
    }
    if (yMin <= 0 && yMax >= 0) {
      svg.appendChild(rc.line(padding, oy, W - padding, oy,
        { stroke: "#222", strokeWidth: 1.8, roughness: 0.4 }));
    }
    addText(svg, W - padding + 12, originInView ? oy + 5 : H - padding + 15, "x", "#444", 16);
    addText(svg, originInView ? ox - 14 : padding - 14, padding - 6, "y", "#444", 16);

    // Lines
    for (const ln of lines) {
      const [x1, y1] = toPx(ln.from[0], ln.from[1]);
      const [x2, y2] = toPx(ln.to[0], ln.to[1]);
      svg.appendChild(rc.line(x1, y1, x2, y2,
        { stroke: ln.color || "#c54b4b", strokeWidth: 2.2, roughness: 0.9 }));
      if (ln.label) addText(svg, (x1 + x2)/2 + 8, (y1 + y2)/2 - 8, ln.label, ln.color || "#c54b4b", 14);
    }

    // Points
    for (const p of points) {
      const [px, py] = toPx(p.x, p.y);
      svg.appendChild(rc.circle(px, py, 10,
        { fill: p.color || "#1e88e5", fillStyle: "solid", stroke: p.color || "#1e88e5" }));
      const lab = p.label || `(${p.x}, ${p.y})`;
      addText(svg, px + 10, py - 10, lab, p.color || "#1e88e5", 14);
    }

    registerCard(label, card);
    appendCard(card);
  }

  // ---------- Unit circle ----------
  function drawUnitCircle(args) {
    const { angleDegrees, showSinCos = true, label, caption } = args;
    const hasAngle = angleDegrees !== undefined && angleDegrees !== null;

    const W = 520, H = 520, padding = 60;
    const cx = W / 2, cy = H / 2;
    const R = Math.min(W, H) / 2 - padding;

    const card = makeDiagramCard(caption);
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("width", String(W));
    svg.setAttribute("height", String(H));
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.style.background = "#fafbff";
    svg.style.borderRadius = "10px";
    svg.style.width = "100%";
    svg.style.height = "auto";
    card.appendChild(svg);
    const rc = window.rough.svg(svg);

    // Axes
    svg.appendChild(rc.line(padding - 10, cy, W - padding + 10, cy,
      { stroke: "#888", strokeWidth: 1.5, roughness: 0.4 }));
    svg.appendChild(rc.line(cx, padding - 10, cx, H - padding + 10,
      { stroke: "#888", strokeWidth: 1.5, roughness: 0.4 }));
    addText(svg, W - padding + 18, cy + 5, "x", "#666", 16);
    addText(svg, cx - 10, padding - 16, "y", "#666", 16);
    // Tick labels (-1, 1)
    addText(svg, cx + R + 2, cy + 18, "1", "#888", 13);
    addText(svg, cx - R - 12, cy + 18, "-1", "#888", 13);
    addText(svg, cx + 6, cy - R - 4, "1", "#888", 13);
    addText(svg, cx + 6, cy + R + 16, "-1", "#888", 13);

    // Circle
    svg.appendChild(rc.circle(cx, cy, R * 2,
      { stroke: "#1e88e5", strokeWidth: 2.2, roughness: 0.7 }));

    if (hasAngle) {
      const theta = angleDegrees * Math.PI / 180;
      const px = cx + R * Math.cos(theta);
      const py = cy - R * Math.sin(theta);

      if (showSinCos) {
        // cos (horizontal projection)
        svg.appendChild(rc.line(cx, cy, px, cy,
          { stroke: "#e6a000", strokeWidth: 2.2, roughness: 0.7 }));
        // sin (vertical projection)
        svg.appendChild(rc.line(px, cy, px, py,
          { stroke: "#2ca95a", strokeWidth: 2.2, roughness: 0.7 }));
        addText(svg, (cx + px)/2, cy + 20, `cos θ = ${Math.cos(theta).toFixed(2)}`, "#e6a000", 14);
        addText(svg, px + 8, (py + cy)/2 + 4, `sin θ = ${Math.sin(theta).toFixed(2)}`, "#2ca95a", 14);
      }

      // Radius
      svg.appendChild(rc.line(cx, cy, px, py,
        { stroke: "#c54b4b", strokeWidth: 2.6, roughness: 0.7 }));
      // Arc
      const arcR = 36;
      const arc = document.createElementNS(SVG_NS, "path");
      const endX = cx + arcR * Math.cos(theta);
      const endY = cy - arcR * Math.sin(theta);
      const largeArc = angleDegrees > 180 ? 1 : 0;
      arc.setAttribute("d", `M ${cx + arcR} ${cy} A ${arcR} ${arcR} 0 ${largeArc} 0 ${endX} ${endY}`);
      arc.setAttribute("fill", "none");
      arc.setAttribute("stroke", "#c54b4b");
      arc.setAttribute("stroke-width", "1.7");
      svg.appendChild(arc);
      addText(svg, cx + arcR + 6, cy - 8, `${angleDegrees}°`, "#c54b4b", 14);

      // Point
      svg.appendChild(rc.circle(px, py, 10,
        { fill: "#c54b4b", fillStyle: "solid", stroke: "#c54b4b" }));
      addText(svg, px + 12, py - 10,
        `(${Math.cos(theta).toFixed(2)}, ${Math.sin(theta).toFixed(2)})`,
        "#c54b4b", 14);
    }

    registerCard(label, card);
    appendCard(card);
  }

  // ---------- Parabola ----------
  function drawParabola(args) {
    const { a, b = 0, c = 0, showRoots = true, showVertex = true,
            xMin, xMax, label, caption } = args;

    if (!a || a === 0) { logWarn("draw_parabola: a must be non-zero"); return; }

    const vx = -b / (2 * a);
    const vy = a * vx * vx + b * vx + c;
    const disc = b * b - 4 * a * c;
    const hasRoots = disc >= 0;
    const r1 = hasRoots ? (-b - Math.sqrt(disc)) / (2 * a) : null;
    const r2 = hasRoots ? (-b + Math.sqrt(disc)) / (2 * a) : null;

    let xmin = xMin, xmax = xMax;
    if (xmin == null || xmax == null) {
      const halfWidth = hasRoots
        ? Math.max(Math.abs(r1 - vx), Math.abs(r2 - vx), 2) * 1.4
        : 5;
      xmin = vx - halfWidth;
      xmax = vx + halfWidth;
    }
    const yAtMax = a * xmax * xmax + b * xmax + c;
    const yAtMin = a * xmin * xmin + b * xmin + c;
    const ymin = Math.min(vy, yAtMax, yAtMin) - 1;
    const ymax = Math.max(vy, yAtMax, yAtMin) + 1;

    const expression = `${a}*x^2 + ${b}*x + ${c}`;
    const annotations = [];
    if (showVertex) {
      annotations.push({ x: vx, text: `Vertex (${+vx.toFixed(2)}, ${+vy.toFixed(2)})` });
    }
    if (showRoots && hasRoots) {
      annotations.push({ x: r1, text: `x = ${+r1.toFixed(2)}` });
      if (Math.abs(r1 - r2) > 0.01) {
        annotations.push({ x: r2, text: `x = ${+r2.toFixed(2)}` });
      }
    }

    const signB = b >= 0 ? "+" : "−";
    const signC = c >= 0 ? "+" : "−";
    const prettyCaption = caption || `y = ${a}x² ${signB} ${Math.abs(b)}x ${signC} ${Math.abs(c)}`;

    plotFunction({
      expression, xMin: xmin, xMax: xmax, yMin: ymin, yMax: ymax,
      label, caption: prettyCaption, annotations,
    });
  }

  // ---------- Generic shapes ----------
  function drawShapes(args) {
    const { shapes = [], width = 600, height = 400, label, caption } = args;
    const card = makeDiagramCard(caption);
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.style.background = "#fafbff";
    svg.style.borderRadius = "10px";
    svg.style.width = "100%";
    svg.style.height = "auto";
    card.appendChild(svg);
    const rc = window.rough.svg(svg);

    for (const s of shapes) {
      const color = s.color || "#1e88e5";
      const fillOpts = s.filled
        ? { fill: color, fillStyle: "hachure", fillWeight: 1.6, hachureGap: 8,
            stroke: color, strokeWidth: 2 }
        : { stroke: color, strokeWidth: 2.2, roughness: 1.4 };
      try {
        switch ((s.type || "").toLowerCase()) {
          case "line":
            svg.appendChild(rc.line(s.x1, s.y1, s.x2, s.y2,
              { stroke: color, strokeWidth: 2.2, roughness: 1.3 }));
            break;
          case "rect": case "rectangle": case "square": {
            let x = s.x, y = s.y, w = s.width, h = s.height;
            if (x == null && s.x1 != null) {
              x = Math.min(s.x1, s.x2); y = Math.min(s.y1, s.y2);
              w = Math.abs(s.x2 - s.x1); h = Math.abs(s.y2 - s.y1);
            }
            if ((s.type || "").toLowerCase() === "square" && h == null) h = w;
            svg.appendChild(rc.rectangle(x, y, w, h, fillOpts));
            if (s.label) addText(svg, x + w / 2, y + h / 2 + 5, s.label, color, s.size || 16);
            break;
          }
          case "circle":
            svg.appendChild(rc.circle(s.cx ?? s.x, s.cy ?? s.y, (s.r || 30) * 2, fillOpts));
            break;
          case "ellipse":
            svg.appendChild(rc.ellipse(s.cx, s.cy, (s.rx || 30) * 2, (s.ry || 20) * 2, fillOpts));
            break;
          case "polygon": case "triangle": {
            const pts = (s.points || []).map(p => [Number(p[0]), Number(p[1])]);
            svg.appendChild(rc.polygon(pts, fillOpts));
            break;
          }
          case "polyline": case "path": {
            const pts = (s.points || []).map(p => [Number(p[0]), Number(p[1])]);
            svg.appendChild(rc.linearPath(pts,
              { stroke: color, strokeWidth: 2.2, roughness: 1.2 }));
            break;
          }
          case "point": case "dot":
            svg.appendChild(rc.circle(s.x ?? s.cx, s.y ?? s.cy, 10,
              { fill: color, fillStyle: "solid", stroke: color }));
            if (s.label) addText(svg, (s.x ?? s.cx) + 10, (s.y ?? s.cy) - 8, s.label, color);
            break;
          case "text": case "label":
            addText(svg, s.x, s.y, s.text || s.label || "", color, s.size || 18);
            break;
          case "arrow":
            drawArrow(svg, rc, s.x1, s.y1, s.x2, s.y2, color, s.label);
            break;
          default:
            logWarn("unknown shape type", s.type, s);
        }
      } catch (e) { logError("shape error", s, e); }
    }

    registerCard(label, card);
    appendCard(card);
  }

  function addText(svg, x, y, text, color, size = 18) {
    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("x", x); t.setAttribute("y", y);
    t.setAttribute("font-family", "ui-rounded, 'SF Pro Rounded', sans-serif");
    t.setAttribute("font-size", String(size));
    t.setAttribute("fill", color || "#1a1a1a");
    t.textContent = text;
    svg.appendChild(t);
  }
  function drawArrow(svg, rc, x1, y1, x2, y2, color, label) {
    svg.appendChild(rc.line(x1, y1, x2, y2,
      { stroke: color, strokeWidth: 2.5, roughness: 1.3 }));
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const ah = 14;
    svg.appendChild(rc.line(x2, y2,
      x2 - ah * Math.cos(angle - Math.PI / 7), y2 - ah * Math.sin(angle - Math.PI / 7),
      { stroke: color, strokeWidth: 2.5, roughness: 1 }));
    svg.appendChild(rc.line(x2, y2,
      x2 - ah * Math.cos(angle + Math.PI / 7), y2 - ah * Math.sin(angle + Math.PI / 7),
      { stroke: color, strokeWidth: 2.5, roughness: 1 }));
    if (label) addText(svg, (x1 + x2) / 2, (y1 + y2) / 2 - 8, label, color, 16);
  }

  // ---------- Raw SVG ----------
  function drawRawSvg({ svg, label, caption }) {
    if (!svg) return;
    const card = makeDiagramCard(caption);
    const holder = document.createElement("div");
    holder.innerHTML = String(svg)
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/\son\w+="[^"]*"/gi, "").replace(/\son\w+='[^']*'/gi, "");
    const svgEl = holder.querySelector("svg");
    if (!svgEl) {
      const err = document.createElement("div");
      err.style.color = "#b00020";
      err.textContent = "draw_svg: no <svg> element";
      card.appendChild(err);
    } else {
      svgEl.removeAttribute("onload");
      svgEl.style.maxWidth = "100%";
      card.appendChild(svgEl);
    }
    registerCard(label, card);
    appendCard(card);
  }

  // ---------- Highlight / clear ----------
  function highlightLabel(label) {
    const node = cardMap.get(label);
    if (!node) return;
    node.classList.add("flash");
    setTimeout(() => node.classList.remove("flash"), 1600);
  }
  function clearBoard() {
    board.innerHTML = "";
    cardMap.clear();
    focusedLabel = null;
    // Also reset step tracker
    stepEl.textContent = "";
  }

  // ==============================================================
  //   Audio playback (24 kHz PCM)
  // ==============================================================
  let outCtx = null;
  let playCursor = 0;
  let playingCount = 0;
  const OUT_RATE = 24000;

  function ensureOutCtx() {
    if (!outCtx) outCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: OUT_RATE });
    return outCtx;
  }
  function enqueuePCM(arrayBuffer) {
    const ctx = ensureOutCtx();
    const pcm = new Int16Array(arrayBuffer);
    if (pcm.length === 0) return;
    const buf = ctx.createBuffer(1, pcm.length, OUT_RATE);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;

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
      for (let i = 0; i < timeData.length; i++) { const v = (timeData[i] - 128) / 128; sum += v * v; }
      setMouthAmplitude(Math.min(1, Math.sqrt(sum / timeData.length) * 4));
      if (ctx.currentTime < startAt + buf.duration) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);

    src.onended = () => {
      playingCount--;
      if (playingCount <= 0) { setMouthAmplitude(0); setAvatarTalking(false); }
    };
  }
  function flushPlayback() {
    if (!outCtx) return;
    try { outCtx.close(); } catch {}
    outCtx = null; playCursor = 0; playingCount = 0;
  }

  // ==============================================================
  //   Mic capture (16 kHz PCM, push-to-talk)
  // ==============================================================
  let inCtx = null, micStream = null, workletNode = null, micSource = null;
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
    workletNode.port.onmessage = (ev) => { if (capturing) sendBytes(ev.data); };
    micSource.connect(workletNode);
  }
  async function startTalking() {
    if (capturing) return;
    try {
      await initMic();
      if (inCtx.state === "suspended") await inCtx.resume();
      capturing = true;
      pttBtn.classList.add("talking");
      setStatus("listening…", "listening");
      sendJSON({ type: "ptt_start" });   // open manual-VAD activity window
    } catch (e) { setStatus("mic error: " + e.message, "error"); }
  }
  function stopTalking() {
    if (!capturing) return;
    capturing = false;
    pttBtn.classList.remove("talking");
    setStatus("thinking…", "live");
    sendJSON({ type: "ptt_end" });       // close manual-VAD activity window
  }

  window.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || e.repeat) return;
    const ae = document.activeElement;
    if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")) return;
    e.preventDefault();
    startTalking();
  });
  window.addEventListener("keyup", (e) => {
    if (e.code !== "Space") return;
    const ae = document.activeElement;
    if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")) return;
    e.preventDefault();
    stopTalking();
  });
  pttBtn.addEventListener("mousedown", startTalking);
  pttBtn.addEventListener("touchstart", (e) => { e.preventDefault(); startTalking(); });
  window.addEventListener("mouseup", stopTalking);
  window.addEventListener("touchend", stopTalking);

  // ==============================================================
  //   Text input
  // ==============================================================
  textForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = textInput.value.trim();
    if (!text) return;
    addLocalBubble("user", text);
    sendJSON({ type: "text", text });
    textInput.value = "";
    setStatus("thinking…", "live");
  });

  // ==============================================================
  //   Language toggle (just cycles label; model reads the sync call)
  // ==============================================================
  langBtn.addEventListener("click", () => {
    const next = langBtn.textContent === "EN" ? "हिं" : "EN";
    langBtn.textContent = next;
    // Nudge the model to switch language via a text turn.
    const nudge = next === "हिं"
      ? "Please switch to Hindi from now on."
      : "Please switch to English from now on.";
    sendJSON({ type: "text", text: nudge });
  });

  // First click unlocks audio output context on strict browsers.
  window.addEventListener("click", () => { ensureOutCtx(); }, { once: true });
})();
