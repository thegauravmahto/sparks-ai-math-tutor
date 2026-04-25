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
    // Lip-sync: grows inside full lip outline via clipPath so it never escapes.
    const ry = 0.7 + currentAmp * 8;    // closed seam → open
    const rx = 12  - currentAmp * 2.5;
    mouth.setAttribute("ry", ry.toFixed(2));
    mouth.setAttribute("rx", rx.toFixed(2));
    // Tongue peeks only when wide open
    tongue.setAttribute("opacity", (currentAmp > 0.4 ? currentAmp * 0.8 : 0).toFixed(2));
    requestAnimationFrame(animateMouth);
  }
  animateMouth();

  // --- Blinking (eye squishes flat then restores to ry=7) ---
  const OPEN_RY = 7;
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
    const pupilBases = [[88, 118], [132, 118]];
    const glintBases = [[90, 115.5], [134, 115.5]];
    eyes.forEach((p, i) => {
      const [bx, by] = pupilBases[i];
      p.setAttribute("cx", bx + mx * 1.6);
      p.setAttribute("cy", by + my * 1.2);
    });
    glints.forEach((g, i) => {
      const [bx, by] = glintBases[i];
      g.setAttribute("cx", bx + mx * 1.6);
      g.setAttribute("cy", by + my * 1.2);
    });
  });

  // --- Talking class toggle ---
  window.setAvatarTalking = function (on) {
    svg.classList.toggle("talking", !!on);
  };
})();
