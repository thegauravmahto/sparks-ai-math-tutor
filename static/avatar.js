// Avatar animation behind three globals (setMouthShape / setAvatarTalking /
// setAvatarEmotion) with two interchangeable backends:
//   - "owl"    (default): the hand-drawn SVG owl in index.html
//   - "live2d" (?avatar=live2d): Live2D sample model via pixi-live2d-display.
//     PROTOTYPE — runtime + model load from CDN, nothing is committed to the
//     repo (the Live2D sample models are NOT MIT-licensed; see CLAUDE.md).
(() => {
  const MODE = new URLSearchParams(location.search).get("avatar") === "live2d"
    ? "live2d" : "owl";

  // --- Shared mouth targets; the active backend consumes them in its loop ---
  // amp 0..1 = how open; shape -1..+1 = vowel hint
  // (-1 = rounded "oo", 0 = neutral "ah", +1 = wide "ee").
  let targetAmp = 0, targetShape = 0;

  window.setMouthShape = function (amp, shape) {
    targetAmp = Math.min(1, Math.max(0, amp));
    targetShape = Math.min(1, Math.max(-1, shape || 0));
  };
  // Back-compat: amplitude-only callers get a neutral shape.
  window.setMouthAmplitude = function (amp) { window.setMouthShape(amp, 0); };
  // No-op defaults so app.js can call these before a backend finishes loading.
  window.setAvatarTalking = function () {};
  window.setAvatarEmotion = function () { return false; };

  const EMOTIONS = ["happy", "thinking", "encouraging", "surprised", "celebrating"];

  // app.js loads after this file and exposes its WS-relayed loggers on
  // window.livetutor. Log to the console immediately, and (re-)send through
  // the relay once it exists so the server terminal sees avatar lifecycle too.
  const report = (level, ...args) => {
    console[level === "info" ? "log" : "warn"]("[avatar]", ...args);
    const viaRelay = () => {
      const lt = window.livetutor || {};
      const fn = { info: lt.logInfo, warn: lt.logWarn, error: lt.logError }[level];
      if (fn) fn("[avatar]", ...args);
      else setTimeout(viaRelay, 500); // app.js not loaded yet
    };
    setTimeout(viaRelay, 0);
  };

  // ==============================================================
  //   Backend: SVG owl
  // ==============================================================
  function initOwl() {
    const svg = document.getElementById("avatar");
    const mouth = document.getElementById("mouth");
    const tongue = document.getElementById("tongue");
    const eyes = document.querySelectorAll("#eyes .pupil");
    const glints = document.querySelectorAll("#eyes .glint");
    const eyeWhites = document.querySelectorAll("#eyes .eye-white");

    // --- Mouth animation driven by the shared amp + shape targets ---
    let currentAmp = 0, currentShape = 0;
    function animateMouth() {
      currentAmp += (targetAmp - currentAmp) * 0.35;
      currentShape += (targetShape - currentShape) * 0.25;
      const wide  = Math.max(0, currentShape);   // "ee"
      const round = Math.max(0, -currentShape);  // "oo"
      // Owl: bigger mouth below the beak. Fades in + expands when talking.
      const ry = (0.8 + currentAmp * 8) * (1 - 0.45 * wide + 0.25 * round);
      const rx = (14  + currentAmp * 2) * (1 + 0.40 * wide - 0.45 * round);
      const op = currentAmp < 0.05 ? 0 : Math.min(1, currentAmp * 4);
      mouth.setAttribute("ry", ry.toFixed(2));
      mouth.setAttribute("rx", rx.toFixed(2));
      mouth.setAttribute("opacity", op.toFixed(2));
      tongue.setAttribute("opacity", (currentAmp > 0.4 ? currentAmp * 0.7 : 0).toFixed(2));
      requestAnimationFrame(animateMouth);
    }
    animateMouth();

    // --- Blinking (eye squishes flat then restores to ry=17) ---
    const OPEN_RY = 17;
    function blink() {
      eyeWhites.forEach((e) => e.setAttribute("ry", "0.6"));
      setTimeout(() => {
        eyeWhites.forEach((e) => e.setAttribute("ry", String(OPEN_RY)));
      }, 130);
      const next = 2500 + Math.random() * 3500;
      setTimeout(blink, next);
    }
    setTimeout(blink, 2000);

    // --- Eye positioning (shared by mouse tracking and emotes) ---
    // mx/my in -1..1; pupils + glints drift inside the white glasses lenses.
    const pupilBases = [[80, 106], [140, 106]];
    const glintBases = [[84, 100], [144, 100]];
    function positionEyes(mx, my) {
      eyes.forEach((p, i) => {
        const [bx, by] = pupilBases[i];
        p.setAttribute("cx", bx + mx * 5);
        p.setAttribute("cy", by + my * 4);
      });
      glints.forEach((g, i) => {
        const [bx, by] = glintBases[i];
        g.setAttribute("cx", bx + mx * 5);
        g.setAttribute("cy", by + my * 4);
      });
    }

    window.addEventListener("mousemove", (e) => {
      if (eyesOverride) return; // an emote is steering the eyes
      const rect = svg.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = (e.clientX - cx) / window.innerWidth;
      const dy = (e.clientY - cy) / window.innerHeight;
      positionEyes(Math.max(-1, Math.min(1, dx * 2)),
                   Math.max(-1, Math.min(1, dy * 2)));
    });

    // --- Emotions (driven by the model's `emote` tool) ---
    let emoteTimer = null;
    let eyesOverride = null;

    function clearEmotion() {
      clearTimeout(emoteTimer);
      emoteTimer = null;
      EMOTIONS.forEach((x) => svg.classList.remove("emote-" + x));
      if (eyesOverride) { eyesOverride = null; positionEyes(0, 0); }
    }

    window.setAvatarEmotion = function (expression) {
      const e = String(expression || "").toLowerCase().trim();
      if (!EMOTIONS.includes(e)) return false;
      clearEmotion();
      // Force reflow so re-triggering the same emote restarts its CSS animation.
      void svg.getBoundingClientRect();
      svg.classList.add("emote-" + e);
      if (e === "thinking") {
        eyesOverride = true;
        positionEyes(-0.5, -1); // gaze up-left, classic "hmm"
      }
      emoteTimer = setTimeout(clearEmotion, e === "thinking" ? 6000 : 3000);
      return true;
    };

    // --- Talking class toggle (drives the idle bob speed) ---
    window.setAvatarTalking = function (on) {
      svg.classList.toggle("talking", !!on);
      // Speech arriving means the "thinking" pause is over.
      if (on && svg.classList.contains("emote-thinking")) clearEmotion();
    };
  }

  // ==============================================================
  //   Backend: Live2D (prototype)
  // ==============================================================
  const LIVE2D_SCRIPTS = [
    // Cubism 4 core runtime (Live2D proprietary license, CDN-only by design)
    "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js",
    "https://cdn.jsdelivr.net/npm/pixi.js@6.5.10/dist/browser/pixi.min.js",
    "https://cdn.jsdelivr.net/npm/pixi-live2d-display@0.4.0/dist/cubism4.min.js",
  ];
  // Haru sample model (Live2D Free Material License — do NOT commit to repo).
  const LIVE2D_MODEL_URL =
    "https://cdn.jsdelivr.net/gh/guansss/pixi-live2d-display/test/assets/haru/haru_greeter_t03.model3.json";

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("script failed: " + src));
      document.head.appendChild(s);
    });
  }

  function teardownLive2D() {
    document.getElementById("avatar-wrap").classList.remove("live2d");
    const canvas = document.getElementById("avatar-canvas");
    if (canvas) canvas.remove();
    document.getElementById("avatar").style.display = "";
  }

  async function initLive2D() {
    const wrap = document.getElementById("avatar-wrap");
    const svg = document.getElementById("avatar");

    report("info", "live2d: loading runtime scripts…");
    for (const src of LIVE2D_SCRIPTS) await loadScript(src); // order matters
    report("info", "live2d: runtime loaded, fetching model…");

    wrap.classList.add("live2d");
    svg.style.display = "none";
    const canvas = document.createElement("canvas");
    canvas.id = "avatar-canvas";
    wrap.insertBefore(canvas, wrap.firstChild);

    // sharedTicker so our param overrides run after the model's own update
    // on the same ticker (FIFO order within a priority).
    const app = new PIXI.Application({
      view: canvas,
      width: wrap.clientWidth,
      height: wrap.clientHeight,
      backgroundAlpha: 0,
      antialias: true,
      sharedTicker: true,
    });

    const model = await PIXI.live2d.Live2DModel.from(LIVE2D_MODEL_URL, {
      autoInteract: false, // wrap has pointer-events:none; we steer focus manually
    });
    app.stage.addChild(model);

    // Crop to the upper body: scale relative to canvas width, anchor near the
    // head. Tweak these two numbers to reframe.
    const ZOOM = 2.4, HEAD_Y = 0.04;
    model.scale.set((app.renderer.width / model.width) * ZOOM);
    model.anchor.set(0.5, HEAD_Y);
    model.position.set(app.renderer.width / 2, 0);

    // --- Mouth: our amp/shape map straight onto Cubism's standard params ---
    const core = model.internalModel.coreModel;
    let amp = 0, shape = 0;
    PIXI.Ticker.shared.add(() => {
      amp += (targetAmp - amp) * 0.35;
      shape += (targetShape - shape) * 0.25;
      core.setParameterValueById("ParamMouthOpenY", Math.min(1, amp * 1.4));
      core.setParameterValueById("ParamMouthForm", shape);
    });

    // --- Eyes follow the mouse (model.focus expects screen coords) ---
    window.addEventListener("mousemove", (e) => model.focus(e.clientX, e.clientY));

    // --- Emotions → Live2D expressions (generic index mapping so any model
    //     with .exp3.json expressions works; Haru ships several) ---
    const exprCount =
      (model.internalModel.settings.expressions || []).length;
    const EMOTION_INDEX = {
      happy: 0, thinking: 1, encouraging: 2, surprised: 3, celebrating: 4,
    };
    window.setAvatarEmotion = function (expression) {
      const e = String(expression || "").toLowerCase().trim();
      if (!(e in EMOTION_INDEX)) return false;
      if (exprCount > 0) model.expression(EMOTION_INDEX[e] % exprCount);
      if (e === "celebrating" || e === "surprised") {
        try { model.motion("TapBody"); } catch { /* model may lack the group */ }
      }
      return true;
    };

    // Live2D idle motion handles blinking/bob; nothing to toggle while talking.
    window.setAvatarTalking = function () {};

    report("info", "live2d avatar ready (expressions: " + exprCount + ")");
  }

  // --- Dispatch (kept at the bottom: initLive2D touches consts above) ---
  if (MODE === "live2d") {
    initLive2D().catch((err) => {
      report("error", "live2d failed, falling back to owl:",
             String((err && err.stack) || err));
      teardownLive2D();
      initOwl();
    });
  } else {
    initOwl();
  }
})();
