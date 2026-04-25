// Avatar animation: mouth scales with audio, blinking, eye tracking mouse.
(() => {
  const svg = document.getElementById("avatar");
  const mouth = document.getElementById("mouth");
  const tongue = document.getElementById("tongue");
  const eyes = document.querySelectorAll("#eyes .pupil");
  const glints = document.querySelectorAll("#eyes .glint");
  const eyeWhites = document.querySelectorAll("#eyes .eye-white");

  // --- Mouth animation driven by audio RMS ---
  let targetAmp = 0;
  let currentAmp = 0;

  window.setMouthAmplitude = function (amp) {
    targetAmp = Math.min(1, Math.max(0, amp));
  };

  function animateMouth() {
    currentAmp += (targetAmp - currentAmp) * 0.35;
    // Owl: bigger mouth below the beak. Fades in + expands when talking.
    const ry = 0.8 + currentAmp * 8;
    const rx = 14  + currentAmp * 2;
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

  // --- Eye tracking (glint drifts with the mouse) ---
  window.addEventListener("mousemove", (e) => {
    const rect = svg.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = (e.clientX - cx) / window.innerWidth;
    const dy = (e.clientY - cy) / window.innerHeight;
    const mx = Math.max(-1, Math.min(1, dx * 2));
    const my = Math.max(-1, Math.min(1, dy * 2));
    // Owl: pupils drift inside the white glasses lenses
    const pupilBases = [[80, 106], [140, 106]];
    const glintBases = [[84, 100], [144, 100]];
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
  });

  // --- Talking class toggle (drives the idle bob speed on body + mouth) ---
  const body = document.getElementById("avatar-body");
  window.setAvatarTalking = function (on) {
    svg.classList.toggle("talking", !!on);
    if (body) body.classList.toggle("talking", !!on);
  };
})();
